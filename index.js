const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.status(200).send("ok"));

app.get("/api/csv", async (_req, res) => {
  try {
    const url = process.env.GOOGLE_SHEET_CSV_URL;
    if (!url) {
      return res.status(500).json({ ok: false, error: "Missing GOOGLE_SHEET_CSV_URL" });
    }

    const response = await fetch(url);
    if (!response.ok) {
      return res.status(502).json({ ok: false, error: `Sheet fetch failed: ${response.status}` });
    }

    const csv = await response.text();
    return res.type("text/csv").send(csv);
  } catch (error) {
    console.error("csv proxy error:", error);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.post("/api/push/register-device", (req, res) => {
  const { token, platform } = req.body || {};
  if (!token || !platform) return res.status(400).json({ ok: false, error: "Missing token/platform" });
  res.status(200).json({ ok: true });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
