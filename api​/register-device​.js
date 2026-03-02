module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const token = body.token;
    const platform = body.platform;

    if (!token || !platform) {
      return res.status(400).json({ ok: false, error: "Missing token or platform" });
    }

    console.log("register-device", { token, platform, at: new Date().toISOString() });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("register-device error", error);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
};
