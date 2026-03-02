module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { token, platform } = body;
    if (!token || !platform) return res.status(400).json({ ok: false, error: "Missing token/platform" });

    console.log("register-device", { token, platform, at: new Date().toISOString() });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}