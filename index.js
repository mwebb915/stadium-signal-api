const express = require("express");
const fs = require("fs");
const path = require("path");
const apn = require("apn");

const app = express();
app.use(express.json());

const SHEET_URL =
  process.env.GOOGLE_SHEET_CSV_URL ||
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTrbyTTdk5GP8_dUIifaPtvavCFbTvSk1PHGAiLYqcZIWteTf25nz-wjrq2e8LGYYKXxmPumSUxGCW0/pub?gid=485285881&single=true&output=csv";

const deviceTokens = new Set();

function getApnsProvider() {
  const rawKey = process.env.APNS_P8_KEY;
  const key = rawKey ? rawKey.replace(/\\n/g, "\n") : null;

  if (!key || !process.env.APNS_KEY_ID || !process.env.APNS_TEAM_ID) {
    throw new Error("Missing APNS credentials env vars");
  }

  return new apn.Provider({
    token: {
      key,
      keyId: process.env.APNS_KEY_ID,
      teamId: process.env.APNS_TEAM_ID
    },
    production: process.env.APNS_PRODUCTION === "true"
  });
}

function requireAdmin(req, res, next) {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) return next(); // optional for now
  if (req.headers["x-admin-key"] !== adminKey) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

app.get("/health", (_req, res) => res.status(200).send("ok"));

app.get("/api/csv", async (_req, res) => {
  try {
    const response = await fetch(SHEET_URL);
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
  if (!token || !platform) {
    return res.status(400).json({ ok: false, error: "Missing token/platform" });
  }
  if (platform !== "ios") {
    return res.status(400).json({ ok: false, error: "Only ios supported" });
  }

  deviceTokens.add(token);
  return res.status(200).json({ ok: true, registered: deviceTokens.size });
});

app.get("/api/push/tokens", requireAdmin, (_req, res) => {
  res.json({ ok: true, count: deviceTokens.size });
});

app.post("/api/push/test-send", requireAdmin, async (req, res) => {
  try {
    const token = req.body?.token || [...deviceTokens][0];
    if (!token) {
      return res.status(400).json({ ok: false, error: "No device token available" });
    }

    const provider = getApnsProvider();
    const note = new apn.Notification();
    note.topic = process.env.APNS_TOPIC; // your iOS bundle id
    note.alert = {
      title: req.body?.title || "Stadium Signal",
      body: req.body?.body || "Test push from Railway"
    };
    note.sound = "default";
    note.payload = { source: "stadium-signal-api" };

    const result = await provider.send(note, token);
    provider.shutdown();

    return res.json({ ok: true, result });
  } catch (error) {
    console.error("push send error:", error);
    return res.status(500).json({ ok: false, error: error.message || "Push send failed" });
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
