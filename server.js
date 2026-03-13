require("dotenv").config();

const express = require("express");
const fs = require("fs");
const cors = require("cors");
const helmet = require("helmet");

const { generalLimiter } = require("./middleware/limiters");
const { addClient, removeClient, sendProgress } = require("./helpers/progress");

const scriptRouter = require("./routes/script");
const clipsRouter = require("./routes/clips");
const voiceRouter = require("./routes/voice");
const videoRouter = require("./routes/video");

/* ── App setup ── */
const app = express();

app.use(helmet());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(generalLimiter);

/* ── SSE progress stream ── */
app.get("/progress", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  addClient(res);
  req.on("close", () => removeClient(res));
});

/* ── Routes ── */
app.use(scriptRouter);
app.use(clipsRouter);
app.use(voiceRouter);
app.use(videoRouter);

/* ── Start ── */
fs.mkdirSync("jobs", { recursive: true });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
