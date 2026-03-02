const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.status(200).send("ok"));

app.get("/api/csv", (_req, res) => {
  const p = path.join(__dirname, "promos.csv");
  res.type("text/csv").send(fs.readFileSync(p, "utf8"));
});

app.post("/api/push/register-device", (req, res) => {
  const { token, platform } = req.body || {};
  if (!token || !platform) return res.status(400).json({ ok: false, error: "Missing token/platform" });
  res.status(200).json({ ok: true });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
