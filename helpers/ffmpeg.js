const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const runCommand = (cmd) =>
  new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error(stderr);
        return reject(err);
      }
      resolve(stdout);
    });
  });

const getAudioDuration = (voicePath) =>
  new Promise((resolve, reject) => {
    exec(
      `ffprobe -i "${voicePath}" -show_entries format=duration -v quiet -of csv="p=0"`,
      (err, stdout) => {
        if (err) return reject(err);
        resolve(parseFloat(stdout));
      }
    );
  });

const downloadVideo = async (url, filename) => {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(
      `Failed to download clip: ${url} — status ${response.status}`
    );
  const fileStream = fs.createWriteStream(filename);
  await new Promise((resolve, reject) => {
    response.body.pipe(fileStream);
    response.body.on("error", reject);
    fileStream.on("finish", resolve);
  });
};

/* Build xfade filter chain for FFmpeg */
const buildXfade = (
  count,
  duration,
  transition,
  jobDir,
  transitionType = "fade"
) => {
  let inputs = "";
  const parts = [];
  for (let i = 0; i < count; i++)
    inputs += `-i "${path.join(jobDir, `clip${i}_fixed.mp4`)}" `;
  let last = "[0:v]";
  for (let i = 1; i < count; i++) {
    const out = `[v${i}]`;
    const offset = i * (duration - transition);
    parts.push(
      `${last}[${i}:v]xfade=transition=${transitionType}:duration=${transition}:offset=${offset}${out}`
    );
    last = out;
  }
  return { inputs, filters: parts.join(";"), last };
};

module.exports = { runCommand, getAudioDuration, downloadVideo, buildXfade };
