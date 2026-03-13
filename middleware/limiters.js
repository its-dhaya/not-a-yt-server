const rateLimit = require("express-rate-limit");

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many requests, please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

const renderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: "Render limit reached. Max 5 videos per hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

const scriptLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: "Script limit reached. Max 20 scripts per hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { generalLimiter, renderLimiter, scriptLimiter };
