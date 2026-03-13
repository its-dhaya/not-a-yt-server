const { createClient } = require("@supabase/supabase-js");

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer "))
      return res
        .status(401)
        .json({ error: "Missing or invalid Authorization header" });

    const token = authHeader.split(" ")[1];
    const {
      data: { user },
      error: authError,
    } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user)
      return res.status(401).json({ error: "Invalid or expired token" });

    const { data: keys, error: keysError } = await supabaseAdmin
      .from("api_keys")
      .select("groq_key, pexels_key, pixabay_key")
      .eq("user_id", user.id)
      .single();

    if (keysError || !keys)
      return res
        .status(403)
        .json({ error: "API keys not found. Please set up your keys first." });

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

module.exports = { requireAuth, supabaseAdmin };
