const express = require("express");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.post("/get-clips", requireAuth, async (req, res) => {
  try {
    const { script, keywords } = req.body;
    const { pexelsKey, pixabayKey } = req.apiKeys;

    const scenes = await Promise.all(
      keywords.filter(Boolean).map(async (keyword, i) => {
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

module.exports = router;
