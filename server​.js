const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

app.get("/api/csv", (req, res) => {
  try {
    const csvPath = path.join(process.cwd(), "promos.csv");
    const csv = fs.readFileSync(csvPath, "utf8");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.status(200).send(csv);
  } catch {
    res.status(500).json({ ok: false, error: "Failed to read CSV" });
  }
});

app.post("/api/push/register-device", (req, res) => {
  const { token, platform } = req.body || {};
  if (!token || !platform) {
    return res.status(400).json({ ok: false, error: "Missing token/platform" });
  }
  console.log("register-device", { token, platform, at: new Date().toISOString() });
  res.status(200).json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on ${port}`));
