require("dotenv").config();

const express = require("express");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { randomUUID } = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();

// SECURITY #6: helmet sets secure HTTP headers in one line
app.use(helmet());

// SECURITY: only allow requests from the deployed frontend
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));

/* -------------------------
   RATE LIMITING
   SECURITY #4: prevent API quota abuse
------------------------- */

// General API limit — 60 requests per minute per IP
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many requests, please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Render limit — max 5 video renders per hour per IP
const renderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: "Render limit reached. Max 5 videos per hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Script generation limit — max 20 per hour per IP
const scriptLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: "Script limit reached. Max 20 scripts per hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalLimiter);

/* -------------------------
   SUPABASE ADMIN CLIENT
   Uses service role key — never exposed to frontend
------------------------- */

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* -------------------------
   AUTH MIDDLEWARE
   SECURITY #2: verify Supabase JWT on every protected request
   Fetches the user's API keys from Supabase so frontend never needs to send them
------------------------- */

const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ error: "Missing or invalid Authorization header" });
    }

    const token = authHeader.split(" ")[1];

    // Verify JWT with Supabase
    const {
      data: { user },
      error: authError,
    } = await supabaseAdmin.auth.getUser(token);

    if (authError || !user) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    // Fetch this user's API keys from Supabase server-side
    // SECURITY #1: keys never travel from browser to server
    const { data: keys, error: keysError } = await supabaseAdmin
      .from("api_keys")
      .select("groq_key, pexels_key, pixabay_key")
      .eq("user_id", user.id)
      .single();

    if (keysError || !keys) {
      return res
        .status(403)
        .json({ error: "API keys not found. Please set up your keys first." });
    }

    req.user = user;
    req.apiKeys = {
      groqKey: keys.groq_key,
      pexelsKey: keys.pexels_key,
      pixabayKey: keys.pixabay_key,
    };

    next();
  } catch (err) {
    console.error("Auth middleware error:", err);
    res.status(500).json({ error: "Authentication failed" });
  }
};

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

app.post("/generate-script", scriptLimiter, requireAuth, async (req, res) => {
  try {
    // SECURITY #1: keys come from server-side Supabase, not request body
    const { topic: rawTopic } = req.body;
    const { groqKey } = req.apiKeys;

    // SECURITY #3: sanitize topic — strip shell metacharacters
    const topic = rawTopic
      .replace(/[`$|;&<>(){}[\]\\"']/g, "")
      .trim()
      .slice(0, 200);

    if (!topic) {
      return res.status(400).json({ error: "Invalid topic" });
    }

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
              content: `Create a 60-second YouTube Shorts facts video about ${topic}.

Return ONLY raw JSON. No markdown, no explanation, no code blocks.

Use EXACTLY 10 scenes. Each scene has:
- "text": one punchy fact sentence (max 20 words)
- "keyword": a stock footage search term (1-3 words, must be a CONCRETE VISUAL noun or place)

KEYWORD RULES (critical):
- Must be something you can SEE in a video (object, animal, place, person, action)
- Must be SPECIFIC not generic — use "great wall china" not "wall", "tiger hunting" not "animal"
- NEVER use abstract words like: history, culture, concept, fact, world, people, ancient, modern, famous, interesting
- If the sentence mentions a named landmark or place — use that exact name as keyword
- If the sentence mentions an animal — use "animal + action" e.g. "elephant bathing"
- If the sentence mentions a person — use their profession or a visual scene e.g. "astronaut space"
- Think: what B-roll footage would a documentary editor pick for this sentence?

BAD keywords: "history", "culture", "people", "ancient times", "world record"
GOOD keywords: "great wall", "silk road camel", "yangtze river", "terracotta soldiers", "panda bamboo"

Format: { "scenes": [ { "text": "...", "keyword": "..." } ] }`,
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

app.post("/get-clips", requireAuth, async (req, res) => {
  try {
    // SECURITY #1: keys from server-side auth middleware
    const { script, keywords } = req.body;
    const { pexelsKey, pixabayKey } = req.apiKeys;

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
   PREVIEW VOICE
   Returns a short MP3 preview of the selected voice
------------------------- */

app.post("/preview-voice", async (req, res) => {
  const { voice, text } = req.body;

  const ALLOWED_VOICES = [
    "en-US-JennyNeural",
    "en-US-GuyNeural",
    "en-GB-SoniaNeural",
    "en-GB-RyanNeural",
    "en-AU-NatashaNeural",
    "en-AU-WilliamNeural",
    "en-IN-NeerjaNeural",
    "en-IN-PrabhatNeural",
  ];

  if (!ALLOWED_VOICES.includes(voice)) {
    return res.status(400).json({ error: "Invalid voice" });
  }

  const previewPath = `preview_${randomUUID()}.mp3`;

  try {
    const safeText = String(text || "Hello, this is a voice preview.")
      .replace(/[`$|;&<>(){}[\]\\"']/g, "")
      .slice(0, 200);

    fs.writeFileSync(`${previewPath}.txt`, safeText);

    await runCommand(
      `python -m edge_tts --text "${safeText}" --voice ${voice} --write-media ${previewPath}`
    );

    res.setHeader("Content-Type", "audio/mpeg");
    const stream = fs.createReadStream(previewPath);
    stream.pipe(res);
    stream.on("end", () => {
      fs.rmSync(previewPath, { force: true });
      fs.rmSync(`${previewPath}.txt`, { force: true });
    });
  } catch (err) {
    console.error("Preview error:", err);
    fs.rmSync(previewPath, { force: true });
    fs.rmSync(`${previewPath}.txt`, { force: true });
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------
   GENERATE VIDEO
   FIX #6: each render gets its own job directory
   so concurrent renders never conflict
------------------------- */

app.post("/generate-video", renderLimiter, requireAuth, async (req, res) => {
  // FIX #6: unique directory per render job
  const jobId = randomUUID();
  const jobDir = path.join("jobs", jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const { script, videoUrls, voice } = req.body;

    // SECURITY #5: validate all inputs before touching the filesystem
    if (
      !Array.isArray(videoUrls) ||
      videoUrls.length === 0 ||
      videoUrls.length > 20
    ) {
      return res
        .status(400)
        .json({ error: "Invalid videoUrls: must be array of 1-20 items" });
    }
    if (!Array.isArray(script) || script.length !== videoUrls.length) {
      return res
        .status(400)
        .json({ error: "script and videoUrls length must match" });
    }

    const urlPattern = /^https?:\/\/.+/;
    const allValidUrls = videoUrls.every(
      (u) => typeof u === "string" && urlPattern.test(u)
    );
    if (!allValidUrls) {
      return res
        .status(400)
        .json({ error: "Invalid videoUrls: all items must be valid URLs" });
    }

    // Sanitize script lines — strip any html/script tags
    const safeScript = script.map((line) =>
      String(line)
        .replace(/<[^>]*>/g, "")
        .trim()
        .slice(0, 500)
    );

    const scriptPath = path.join(jobDir, "script.txt");
    const voicePath = path.join(jobDir, "voice.mp3");
    const srtSrc = path.join(jobDir, "voice.mp3.srt"); // what whisper actually outputs
    const srtPath = path.join(jobDir, "voice.srt"); // what ffmpeg expects
    const tempVideo = path.join(jobDir, "temp_video.mp4");
    const outputPath = path.join(jobDir, "output.mp4");
    const bgPath = "bg.mp3"; // shared read-only asset, safe

    /* Step 1: TTS */
    sendProgress("Generating voiceover...", 10);

    fs.writeFileSync(scriptPath, safeScript.join(" "));

    const safeVoice = [
      "en-US-JennyNeural",
      "en-US-GuyNeural",
      "en-GB-SoniaNeural",
      "en-GB-RyanNeural",
      "en-AU-NatashaNeural",
      "en-AU-WilliamNeural",
      "en-IN-NeerjaNeural",
      "en-IN-PrabhatNeural",
    ].includes(voice)
      ? voice
      : "en-US-JennyNeural";

    await runCommand(
      `python -m edge_tts --file "${scriptPath}" --voice ${safeVoice} --write-media "${voicePath}"`
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
