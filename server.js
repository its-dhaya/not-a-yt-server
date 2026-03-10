const express = require("express");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { randomUUID } = require("crypto");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(cors());
app.use(express.json());

/* -------------------------
   PROGRESS UPDATES (SSE)
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
              content: `Create a 60 second YouTube Shorts facts video about ${topic}. IMPORTANT RULES: Do not wrap with json. Return ONLY RAW JSON. Use EXACTLY 10 scenes. Each scene must contain text and keyword (simple visual noun related to the sentence). Keyword must be visual, easy for stock videos, and 1-2 words only. If the sentence contains a famous place or named object, the keyword must be a combined phrase (1-2 words). Format: { "scenes": [ { "text": "...", "keyword": "word1 word2" } ] }`,
            },
          ],
        }),
      }
    );

    const data = await response.json();
    const raw = data.choices[0].message.content;

    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}") + 1;

    if (jsonStart === -1 || jsonEnd === 0) {
      throw new Error("Groq did not return valid JSON");
    }

    const cleanJson = raw.substring(jsonStart, jsonEnd);
    const parsed = JSON.parse(cleanJson);

    const script = parsed.scenes.map((s) => s.text);

    // FIX #5: keyword always normalized to a string, never an array
    const keywords = parsed.scenes.map((s) =>
      Array.isArray(s.keyword) ? s.keyword.join(" ") : s.keyword
    );

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
        // FIX #5: normalize keyword to string before using in URL
        const keywordStr = Array.isArray(keyword) ? keyword.join(" ") : keyword;

        const [pexelsRes, pixabayRes] = await Promise.all([
          fetch(
            `https://api.pexels.com/videos/search?query=${encodeURIComponent(
              keywordStr
            )}&per_page=10`,
            { headers: { Authorization: pexelsKey } }
          ),
          fetch(
            `https://pixabay.com/api/videos/?key=${pixabayKey}&q=${encodeURIComponent(
              keywordStr
            )}&per_page=10`
          ),
        ]);

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

        let clips = [...pexelsClips, ...pixabayClips];

        const seen = new Set();
        clips = clips.filter((c) => {
          if (seen.has(c.preview)) return false;
          seen.add(c.preview);
          return true;
        });

        // FIX #9: correct backup fill using its own index counter
        if (clips.length < 10) {
          const backup = [...pexelsClips, ...pixabayClips];
          let idx = 0;
          while (clips.length < 10 && backup.length > 0) {
            clips.push(backup[idx % backup.length]);
            idx++;
          }
        }

        clips = clips.slice(0, 10);

        console.log(
          `Scene ${i + 1} | Keyword: ${keywordStr} | Clips: ${clips.length}`
        );

        return { scene: i, text: script[i] || "", keyword: keywordStr, clips };
      })
    );

    res.json({ scenes });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------
   GENERATE VIDEO
   FIX #6: each render gets its own job directory
   so concurrent renders never conflict
------------------------- */

app.post("/generate-video", async (req, res) => {
  // FIX #6: unique directory per render job
  const jobId = randomUUID();
  const jobDir = path.join("jobs", jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const { script, videoUrls } = req.body;

    const scriptPath = path.join(jobDir, "script.txt");
    const voicePath = path.join(jobDir, "voice.mp3");
    const srtSrc = path.join(jobDir, "voice.mp3.srt"); // what whisper actually outputs
    const srtPath = path.join(jobDir, "voice.srt"); // what ffmpeg expects
    const tempVideo = path.join(jobDir, "temp_video.mp4");
    const outputPath = path.join(jobDir, "output.mp4");
    const bgPath = "bg.mp3"; // shared read-only asset, safe

    /* Step 1: TTS */
    sendProgress("Generating voiceover...", 10);

    fs.writeFileSync(scriptPath, script.join(" "));

    await runCommand(
      `python -m edge_tts --file "${scriptPath}" --voice en-US-JennyNeural --write-media "${voicePath}"`
    );

    /* Step 2: Audio duration */
    sendProgress("Analysing audio...", 20);

    const audioDuration = await getAudioDuration(voicePath);
    console.log("Audio Duration:", audioDuration);

    const transitionDuration = 0.3;
    const clipCount = videoUrls.length;
    const clipDuration = audioDuration / clipCount + transitionDuration + 0.2;

    console.log("Clip Duration:", clipDuration);

    /* Step 3: Download clips — FIX #1: node-fetch follows redirects */
    sendProgress("Downloading clips...", 30);

    await Promise.all(
      videoUrls.map((url, i) =>
        downloadVideo(url, path.join(jobDir, `clip${i}.mp4`))
      )
    );

    /* Step 4: Fix clip sizes */
    sendProgress("Processing clips...", 45);

    for (let i = 0; i < clipCount; i++) {
      const clipIn = path.join(jobDir, `clip${i}.mp4`);
      const clipOut = path.join(jobDir, `clip${i}_fixed.mp4`);
      await runCommand(
        `ffmpeg -stream_loop -1 -i "${clipIn}" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" -t ${clipDuration} -r 30 -c:v libx264 -preset ultrafast -an "${clipOut}" -y`
      );
    }

    /* Step 5: Generate subtitles */
    sendProgress("Generating subtitles...", 60);

    await runCommand(
      `python -m whisper "${voicePath}" --model base --output_format srt --output_dir "${jobDir}"`
    );

    // FIX #2: find whatever .srt whisper created (name varies by version)
    // e.g. voice.srt, voice.mp3.srt, voice.mp3.0.srt -- scan and grab first one
    const srtFiles = fs.readdirSync(jobDir).filter((f) => f.endsWith(".srt"));

    if (srtFiles.length === 0) {
      throw new Error(`Whisper did not produce any SRT file in: ${jobDir}`);
    }

    const actualSrt = path.join(jobDir, srtFiles[0]);
    console.log("Whisper SRT found:", actualSrt);

    if (actualSrt !== srtPath) {
      fs.renameSync(actualSrt, srtPath);
    }

    /* Step 6: Stitch clips with xfade transitions */
    sendProgress("Stitching clips together...", 72);

    // FIX #3 + #4: no trailing semicolon, correct offset per clip
    const { inputs, filters, last } = buildXfade(
      clipCount,
      clipDuration,
      transitionDuration,
      jobDir
    );

    await runCommand(
      `ffmpeg ${inputs} -filter_complex "${filters}" -map "${last}" -threads 4 "${tempVideo}" -y`
    );

    /* Step 7: Mix audio + burn subtitles */
    sendProgress("Adding audio and subtitles...", 88);

    // FFmpeg subtitle filter on Windows requires forward slashes in path
    const srtPathFwd = srtPath.replace(/\\/g, "/");

    await runCommand(
      `ffmpeg -i "${tempVideo}" -i "${voicePath}" -i "${bgPath}" \
      -filter_complex "[2:a]volume=0.15[a2];[1:a][a2]amix=inputs=2:duration=first[a]" \
      -vf "subtitles=${srtPathFwd}:force_style='Fontsize=9,PrimaryColour=&H00FFFF&,OutlineColour=&H000000&,Outline=1,Shadow=0.5,MarginV=20,Alignment=2,BorderStyle=1,Bold=1'" \
      -map 0:v -map "[a]" \
      -c:v libx264 -preset ultrafast -threads 4 -pix_fmt yuv420p -c:a aac -shortest "${outputPath}" -y`
    );

    sendProgress("Done!", 100);
    console.log("Video rendering complete:", outputPath);

    res.json({ success: true, jobId });
  } catch (err) {
    console.error(err);
    // Cleanup job dir on failure so stale files don't linger
    fs.rmSync(jobDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------
   DOWNLOAD FINAL VIDEO
   FIX #6: scoped to jobId — each user downloads their own file
------------------------- */

// Stream endpoint — used by the <video> preview player, no cleanup
app.get("/stream/:jobId", (req, res) => {
  const outputPath = path.join("jobs", req.params.jobId, "output.mp4");

  if (!fs.existsSync(outputPath)) {
    return res.status(404).json({ error: "Video not found" });
  }

  res.sendFile(path.resolve(outputPath));
});

// Download endpoint — triggers file save in browser, cleans up after
app.get("/download/:jobId", (req, res) => {
  const outputPath = path.join("jobs", req.params.jobId, "output.mp4");

  if (!fs.existsSync(outputPath)) {
    return res.status(404).json({ error: "Video not found" });
  }

  res.download(outputPath, "output.mp4", (err) => {
    if (err && err.code !== "ECONNABORTED") {
      console.error("Download error:", err);
    } else {
      // Cleanup job dir after successful download
      fs.rmSync(path.join("jobs", req.params.jobId), {
        recursive: true,
        force: true,
      });
    }
  });
});

/* -------------------------
   HELPERS
------------------------- */

// FIX #1: node-fetch follows redirects automatically
const downloadVideo = async (url, filename) => {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to download clip: ${url} — status ${response.status}`
    );
  }

  const fileStream = fs.createWriteStream(filename);

  await new Promise((resolve, reject) => {
    response.body.pipe(fileStream);
    response.body.on("error", reject);
    fileStream.on("finish", resolve);
  });
};

const runCommand = (cmd) => {
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

const getAudioDuration = (voicePath) => {
  return new Promise((resolve, reject) => {
    exec(
      `ffprobe -i "${voicePath}" -show_entries format=duration -v quiet -of csv="p=0"`,
      (err, stdout) => {
        if (err) return reject(err);
        resolve(parseFloat(stdout));
      }
    );
  });
};

// FIX #3: join with ; — no trailing semicolon
// FIX #4: offset = i * (duration - transition) — correct per-clip shift
const buildXfade = (count, duration, transition, jobDir) => {
  let inputs = "";
  const parts = [];

  for (let i = 0; i < count; i++) {
    inputs += `-i "${path.join(jobDir, `clip${i}_fixed.mp4`)}" `;
  }

  let last = "[0:v]";

  for (let i = 1; i < count; i++) {
    const out = `[v${i}]`;
    const offset = i * (duration - transition);
    parts.push(
      `${last}[${i}:v]xfade=transition=fade:duration=${transition}:offset=${offset}${out}`
    );
    last = out;
  }

  const filters = parts.join(";");

  return { inputs, filters, last };
};

/* -------------------------
   SERVER
------------------------- */

// Ensure jobs directory exists on startup
fs.mkdirSync("jobs", { recursive: true });

app.listen(3000, () => {
  console.log("Video server running on port 3000");
});
