const express = require("express");
const fs = require("fs");
const { randomUUID } = require("crypto");
const { runCommand } = require("../helpers/ffmpeg");

const router = express.Router();

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

router.post("/preview-voice", async (req, res) => {
  const { voice, text } = req.body;
  if (!ALLOWED_VOICES.includes(voice))
    return res.status(400).json({ error: "Invalid voice" });

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

module.exports = router;
module.exports.ALLOWED_VOICES = ALLOWED_VOICES;
