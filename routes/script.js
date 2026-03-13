const express = require("express");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const { requireAuth } = require("../middleware/auth");
const { scriptLimiter } = require("../middleware/limiters");

const router = express.Router();

router.post(
  "/generate-script",
  scriptLimiter,
  requireAuth,
  async (req, res) => {
    try {
      const { topic: rawTopic } = req.body;
      const { groqKey } = req.apiKeys;

      const topic = rawTopic
        .replace(/[`$|;&<>(){}[\]\\"']/g, "")
        .trim()
        .slice(0, 200);

      if (!topic) return res.status(400).json({ error: "Invalid topic" });

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
      if (jsonStart === -1 || jsonEnd === 0)
        throw new Error("Groq did not return valid JSON");

      const parsed = JSON.parse(raw.substring(jsonStart, jsonEnd));
      const script = parsed.scenes.map((s) => s.text);
      const keywords = parsed.scenes.map((s) =>
        Array.isArray(s.keyword) ? s.keyword.join(" ") : s.keyword
      );

      res.json({ script, keywords });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
