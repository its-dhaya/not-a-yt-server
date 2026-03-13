const express = require("express");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const { requireAuth } = require("../middleware/auth");
const { renderLimiter } = require("../middleware/limiters");
const { resolveTheme } = require("../constants/themes");
const { sendProgress } = require("../helpers/progress");
const {
  runCommand,
  getAudioDuration,
  downloadVideo,
  buildXfade,
} = require("../helpers/ffmpeg");
const { ALLOWED_VOICES } = require("./voice");

const router = express.Router();

/* -------------------------
   GENERATE VIDEO
------------------------- */
router.post("/generate-video", renderLimiter, requireAuth, async (req, res) => {
  const jobId = randomUUID();
  const jobDir = path.join("jobs", jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const { videoUrls, voice, script, themeId, themeSettings } = req.body;

    // Resolve theme
    const theme = resolveTheme(themeId, themeSettings);

    // Validate inputs
    if (
      !Array.isArray(videoUrls) ||
      videoUrls.length === 0 ||
      videoUrls.length > 20
    )
      return res
        .status(400)
        .json({ error: "Invalid videoUrls: must be array of 1-20 items" });
    if (!Array.isArray(script) || script.length !== videoUrls.length)
      return res
        .status(400)
        .json({ error: "script and videoUrls length must match" });
    const urlPattern = /^https?:\/\/.+/;
    if (!videoUrls.every((u) => typeof u === "string" && urlPattern.test(u)))
      return res
        .status(400)
        .json({ error: "Invalid videoUrls: all items must be valid URLs" });

    const safeScript = script.map((line) =>
      String(line)
        .replace(/<[^>]*>/g, "")
        .trim()
        .slice(0, 500)
    );

    const scriptPath = path.join(jobDir, "script.txt");
    const voicePath = path.join(jobDir, "voice.mp3");
    const srtPath = path.join(jobDir, "voice.srt");
    const tempVideo = path.join(jobDir, "temp_video.mp4");
    const outputPath = path.join(jobDir, "output.mp4");
    const bgPath = "bg.mp3";

    /* Step 1: TTS */
    sendProgress("Generating voiceover...", 10);
    const safeVoice = ALLOWED_VOICES.includes(voice)
      ? voice
      : "en-US-JennyNeural";

    // Generate each sentence as its own mp3
    for (let i = 0; i < safeScript.length; i++) {
      const sentText = safeScript[i]
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2013\u2014]/g, "-")
        .replace(/[^\x00-\x7F]/g, "")
        .trim();
      const sentPath = path.join(jobDir, `sent${i}.mp3`);
      await runCommand(
        `python -m edge_tts --text "${sentText}" --voice ${safeVoice} --write-media "${sentPath}"`
      );
    }

    // Create a 0.4s silence mp3
    const silencePath = path.join(jobDir, "silence.mp3");
    await runCommand(
      `ffmpeg -f lavfi -i anullsrc=r=24000:cl=mono -t 0.4 -q:a 9 -acodec libmp3lame "${silencePath}" -y`
    );

    // Build concat list: sent0, silence, sent1, silence, ...
    const concatList = path.join(jobDir, "concat.txt");
    let concatContent = "";
    for (let i = 0; i < safeScript.length; i++) {
      concatContent += `file '${path
        .resolve(jobDir, `sent${i}.mp3`)
        .replace(/\\/g, "/")}'\n`;
      concatContent += `file '${path
        .resolve(silencePath)
        .replace(/\\/g, "/")}'\n`;
    }
    fs.writeFileSync(concatList, concatContent);

    // Concat all into final voice.mp3
    await runCommand(
      `ffmpeg -f concat -safe 0 -i "${concatList}" -c copy "${voicePath}" -y`
    );

    /* Step 2: Audio duration */
    sendProgress("Analysing audio...", 20);
    const audioDuration = await getAudioDuration(voicePath);
    const transitionDuration = 0.3;
    const clipCount = videoUrls.length;
    const clipDuration = audioDuration / clipCount + transitionDuration + 0.2;
    console.log(`Audio: ${audioDuration}s | Clip: ${clipDuration}s`);

    /* Step 3: Download clips */
    sendProgress("Downloading clips...", 30);
    await Promise.all(
      videoUrls.map((url, i) =>
        downloadVideo(url, path.join(jobDir, `clip${i}.mp4`))
      )
    );

    /* Step 4: Resize clips */
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

    const srtFiles = fs.readdirSync(jobDir).filter((f) => f.endsWith(".srt"));
    if (srtFiles.length === 0)
      throw new Error(`Whisper did not produce any SRT file in: ${jobDir}`);
    const actualSrt = path.join(jobDir, srtFiles[0]);
    if (actualSrt !== srtPath) fs.renameSync(actualSrt, srtPath);
    console.log("Whisper SRT found:", actualSrt);

    /* Step 6: Stitch clips */
    sendProgress("Stitching clips together...", 72);
    const { inputs, filters, last } = buildXfade(
      clipCount,
      clipDuration,
      transitionDuration,
      jobDir,
      theme.transition
    );
    await runCommand(
      `ffmpeg ${inputs} -filter_complex "${filters}" -map "${last}" -threads 4 "${tempVideo}" -y`
    );

    /* Step 7: Mix audio + burn subtitles */
    sendProgress("Adding audio and subtitles...", 88);
    const srtPathFwd = srtPath.replace(/\\/g, "/");
    await runCommand(
      `ffmpeg -i "${tempVideo}" -i "${voicePath}" -i "${bgPath}" \
      -filter_complex "[2:a]volume=0.15[a2];[1:a][a2]amix=inputs=2:duration=first[a]" \
      -vf "subtitles=${srtPathFwd}:force_style='Fontsize=${theme.fontSize},PrimaryColour=${theme.subtitleColor},OutlineColour=&H000000&,Outline=${theme.outline},Shadow=${theme.shadow},MarginV=${theme.marginV},Alignment=${theme.alignment},BorderStyle=1,Bold=${theme.bold}'" \
      -map 0:v -map "[a]" \
      -c:v libx264 -preset ultrafast -threads 4 -pix_fmt yuv420p -c:a aac -shortest "${outputPath}" -y`
    );

    sendProgress("Done!", 100);
    console.log("Video rendering complete:", outputPath);
    res.json({ success: true, jobId });
  } catch (err) {
    console.error(err);
    fs.rmSync(jobDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------
   STREAM & DOWNLOAD
------------------------- */
router.get("/stream/:jobId", (req, res) => {
  const outputPath = path.join("jobs", req.params.jobId, "output.mp4");
  if (!fs.existsSync(outputPath))
    return res.status(404).json({ error: "Video not found" });
  res.sendFile(path.resolve(outputPath));
});

router.get("/download/:jobId", (req, res) => {
  const outputPath = path.join("jobs", req.params.jobId, "output.mp4");
  if (!fs.existsSync(outputPath))
    return res.status(404).json({ error: "Video not found" });
  res.download(outputPath, "output.mp4", (err) => {
    if (err && err.code !== "ECONNABORTED")
      console.error("Download error:", err);
    else
      fs.rmSync(path.join("jobs", req.params.jobId), {
        recursive: true,
        force: true,
      });
  });
});

module.exports = router;
