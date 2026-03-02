app.get("/api/csv", async (_req, res) => {
  try {
    const url = process.env.GOOGLE_SHEET_CSV_URL;
    if (!url) return res.status(500).json({ ok: false, error: "Missing GOOGLE_SHEET_CSV_URL" });

    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ ok: false, error: "Failed to fetch sheet CSV" });

    const csv = await r.text();
    res.type("text/csv").send(csv);
  } catch {
    res.status(500).json({ ok: false, error: "Server error" });
  }
});
