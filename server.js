const express = require("express");
const { exec } = require("child_process");
const https = require("https");
const fs = require("fs");
const cors = require("cors");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(cors());
app.use(express.json());

/* -------------------------
   PROGRESS UPDATES
------------------------- */

let clients = [];

app.get("/progress", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  clients.push(res);

  req.on("close", () => {
    clients = clients.filter((client) => client !== res);
  });
});

function sendProgress(step, percent) {
  const data = JSON.stringify({ step, percent });

  clients.forEach((client) => {
    client.write(`data: ${data}\n\n`);
  });
}

/* -------------------------
   GENERATE SCRIPT
------------------------- */
app.post("/generate-script", async (req, res) => {
  try {
    const { topic, groqKey } = req.body;

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${groqKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          messages: [
            {
              role: "user",
              content: `{{ 'Create a 60 second YouTube Shorts facts about ${topic}. IMPORTANT RULES: Do not wrap with json. Return ONLY RAW JSON. Use EXACTLY 10 scenes. Each scene must contain text and keyword (simple visual noun related to the sentence). Keyword must be visual, easy for stock videos, and 1–2 words only. If the sentence contains a famous place or named object, the keyword must be a combined phrase (1–2 words). Format: { scenes:[ {text:...,keyword:[word1 word2]} ] }`,
            },
          ],
        }),
      }
    );

    const data = await response.json();

    const raw = data.choices[0].message.content;

    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}") + 1;

    const cleanJson = raw.substring(jsonStart, jsonEnd);

    const parsed = JSON.parse(cleanJson);

    const script = parsed.scenes.map((s) => s.text);
    const keywords = parsed.scenes.map((s) => s.keyword);

    res.json({ script, keywords });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------
   GET CLIPS 
------------------------- */

app.post("/get-clips", async (req, res) => {
  try {
    const { script, keywords, pexelsKey, pixabayKey } = req.body;

    const scenes = await Promise.all(
      keywords.filter(Boolean).map(async (keyword, i) => {
        /* -------------------------
           FETCH BOTH APIs IN PARALLEL
        ------------------------- */

        const [pexelsRes, pixabayRes] = await Promise.all([
          fetch(
            `https://api.pexels.com/videos/search?query=${encodeURIComponent(
              keyword
            )}&per_page=10`,
            {
              headers: {
                Authorization: pexelsKey,
              },
            }
          ),
          fetch(
            `https://pixabay.com/api/videos/?key=${pixabayKey}&q=${encodeURIComponent(
              keyword
            )}&per_page=10`
          ),
        ]);

        /* -------------------------
           PEXELS CLIPS
        ------------------------- */

        let pexelsClips = [];

        try {
          if (pexelsRes.ok) {
            const data = await pexelsRes.json();

            pexelsClips = (data.videos || []).map((v) => {
              const best =
                v.video_files.find((f) => f.height >= 1080) ||
                v.video_files.sort((a, b) => b.height - a.height)[0];

              return {
                preview: best.link,
                width: best.width,
                height: best.height,
                source: "pexels",
              };
            });
          } else {
            console.log("Pexels error:", await pexelsRes.text());
          }
        } catch (err) {
          console.log("Pexels parsing error:", err.message);
        }

        /* -------------------------
           PIXABAY CLIPS
        ------------------------- */

        let pixabayClips = [];

        try {
          if (pixabayRes.ok) {
            const data = await pixabayRes.json();

            pixabayClips = (data.hits || []).map((v) => {
              const best = v.videos.large || v.videos.medium || v.videos.small;

              return {
                preview: best.url,
                width: best.width,
                height: best.height,
                source: "pixabay",
              };
            });
          } else {
            console.log("Pixabay error:", await pixabayRes.text());
          }
        } catch (err) {
          console.log("Pixabay parsing error:", err.message);
        }

        /* -------------------------
           MERGE CLIPS
        ------------------------- */

        let clips = [...pexelsClips, ...pixabayClips];

        /* -------------------------
           REMOVE DUPLICATES
        ------------------------- */

        const seen = new Set();
        clips = clips.filter((c) => {
          if (seen.has(c.preview)) return false;
          seen.add(c.preview);
          return true;
        });

        /* -------------------------
           GUARANTEE 10 CLIPS
        ------------------------- */

        if (clips.length < 10) {
          const backup = [...pexelsClips, ...pixabayClips];

          while (clips.length < 10 && backup.length > 0) {
            clips.push(backup[clips.length % backup.length]);
          }
        }

        clips = clips.slice(0, 10);

        console.log(
          `Scene ${i + 1} | Keyword: ${keyword} | Clips: ${clips.length}`
        );

        return {
          scene: i,
          text: script[i] || "",
          keyword,
          clips,
        };
      })
    );

    res.json({ scenes });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------
   TEXT TO SPEECH
------------------------- */

app.post("/tts", (req, res) => {
  const text = req.body.text;

  fs.writeFileSync("script.txt", text);

  exec(
    `python -m edge_tts --file script.txt --voice en-US-JennyNeural --write-media voice.mp3`,
    (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true });
    }
  );
});

/* -------------------------
  RENDER VIDEO
------------------------- */

app.post("/generate-video", async (req, res) => {
  try {
    const { script, videoUrls } = req.body;

    /* -------------------------
       STEP 1: Generate TTS
    ------------------------- */

    fs.writeFileSync("script.txt", script.join(" "));

    await new Promise((resolve, reject) => {
      exec(
        `python -m edge_tts --file script.txt --voice en-US-JennyNeural --write-media voice.mp3`,
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });

    /* -------------------------
       STEP 2: Call video render
    ------------------------- */

    const response = await fetch("http://localhost:3000/video", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        videoUrls,
      }),
    });

    const data = await response.json();

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------
   VIDEO GENERATION
------------------------- */

app.post("/video", async (req, res) => {
  const urls = req.body.videoUrls;

  const downloadVideo = (url, filename) => {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filename);

      https
        .get(url, (response) => {
          response.pipe(file);
          file.on("finish", () => {
            file.close(resolve);
          });
        })
        .on("error", reject);
    });
  };

  const runFFmpeg = (cmd) => {
    return new Promise((resolve, reject) => {
      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          console.error(stderr);
          return reject(err);
        }
        resolve(stdout);
      });
    });
  };

  const getAudioDuration = () => {
    return new Promise((resolve, reject) => {
      exec(
        `ffprobe -i voice.mp3 -show_entries format=duration -v quiet -of csv="p=0"`,
        (err, stdout) => {
          if (err) return reject(err);
          resolve(parseFloat(stdout));
        }
      );
    });
  };

  const createSubtitles = () => {
    return new Promise((resolve, reject) => {
      exec(
        `python -m whisper voice.mp3 --model base --output_format srt --output_dir .`,
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  };

  /* -------------------------
     BUILD XFADE PIPELINE
  ------------------------- */

  const buildXfade = (count, duration, transition) => {
    let inputs = "";
    let filters = "";

    for (let i = 0; i < count; i++) {
      inputs += `-i clip${i}_fixed.mp4 `;
    }

    let last = "[0:v]";
    let offset = duration - transition;

    for (let i = 1; i < count; i++) {
      const out = `[v${i}]`;

      filters += `${last}[${i}:v]xfade=transition=fade:duration=${transition}:offset=${offset}${out};`;

      last = out;

      offset += duration - transition;
    }

    return { inputs, filters, last };
  };

  try {
    /* -------------------------
       GET AUDIO LENGTH
    ------------------------- */

    const audioDuration = await getAudioDuration();

    console.log("Audio Duration:", audioDuration);

    const transitionDuration = 0.3;

    const clipDuration = audioDuration / urls.length + transitionDuration + 0.2;

    console.log("Clip Duration:", clipDuration);

    /* -------------------------
       DOWNLOAD CLIPS
    ------------------------- */

    await Promise.all(
      urls.map((url, i) => {
        console.log("Downloading clip", i);
        return downloadVideo(url, `clip${i}.mp4`);
      })
    );
    /* -------------------------
       FIX CLIP SIZE + DURATION
    ------------------------- */

    for (let i = 0; i < urls.length; i++) {
      await runFFmpeg(
        `ffmpeg -stream_loop -1 -i clip${i}.mp4 -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" -t ${clipDuration} -r 30 -c:v libx264 -preset ultrafast -an clip${i}_fixed.mp4 -y`
      );
    }

    /* -------------------------
       GENERATE SUBTITLES
    ------------------------- */

    await createSubtitles();

    /* -------------------------
       BUILD VIDEO WITH TRANSITIONS
    ------------------------- */

    const { inputs, filters, last } = buildXfade(
      urls.length,
      clipDuration,
      transitionDuration
    );

    await runFFmpeg(
      `ffmpeg ${inputs} -filter_complex "${filters}" -map "${last}" -threads 4 temp_video.mp4 -y`
    );

    /* -------------------------
       ADD AUDIO + SUBTITLES
    ------------------------- */

    await runFFmpeg(
      `ffmpeg -i temp_video.mp4 -i voice.mp3 -i bg.mp3 \
      -filter_complex "[2:a]volume=0.15[a2];[1:a][a2]amix=inputs=2:duration=first[a]" \
      -vf "subtitles=voice.srt:force_style='Fontsize=9,PrimaryColour=&H00FFFF&,OutlineColour=&H000000&,Outline=1,Shadow=0.5,MarginV=20,Alignment=2,BorderStyle=1,Bold=1'" \
      -map 0:v -map "[a]" \
      -c:v libx264 -preset ultrafast -threads 4 -pix_fmt yuv420p -c:a aac -shortest output.mp4 -y`
    );

    console.log("Video rendering complete");

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------
   DOWNLOAD FINAL VIDEO
------------------------- */

app.get("/download", (req, res) => {
  res.download("output.mp4");
});

/* -------------------------
   SERVER
------------------------- */

app.listen(3000, () => {
  console.log("Video server running on port 3000");
});
