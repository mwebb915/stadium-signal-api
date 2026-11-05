const express = require("express");
const apn = require("apn");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const BASEBALL_SHEET_URL =
  process.env.GOOGLE_SHEET_CSV_URL ||
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTrbyTTdk5GP8_dUIifaPtvavCFbTvSk1PHGAiLYqcZIWteTf25nz-wjrq2e8LGYYKXxmPumSUxGCW0/pub?gid=485285881&single=true&output=csv";

const SUPPLEMENTAL_SHEET_BASE_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vREkk-eLUS8420RhfAG9NaYH4_b4NK1L0_BWfx9o2_ky6F5EDjWz6zTJJML0etfgfV0--z0bqB7KxAp/pub?output=csv";

const DEFAULT_SHEET_SOURCES = [
  { sport: "baseball", url: BASEBALL_SHEET_URL },
  { sport: "NBA", url: `${SUPPLEMENTAL_SHEET_BASE_URL}&gid=83950458` },
  { sport: "NHL", url: `${SUPPLEMENTAL_SHEET_BASE_URL}&gid=1720312924` },
  { sport: "NFL", url: `${SUPPLEMENTAL_SHEET_BASE_URL}&gid=32429578` },
  { sport: "WNBA", url: `${SUPPLEMENTAL_SHEET_BASE_URL}&gid=1283244495` },
  { sport: "MLS", url: `${SUPPLEMENTAL_SHEET_BASE_URL}&gid=187494945` },
  { sport: "NWSL", url: `${SUPPLEMENTAL_SHEET_BASE_URL}&gid=1920437643` }
];

function getSheetSources() {
  if (!process.env.SHEET_SOURCES_JSON) return DEFAULT_SHEET_SOURCES;

  const configured = JSON.parse(process.env.SHEET_SOURCES_JSON);
  if (!Array.isArray(configured) || configured.some((source) => !source?.sport || !source?.url)) {
    throw new Error("SHEET_SOURCES_JSON must be an array of { sport, url } objects");
  }
  return configured;
}

const sheetSources = getSheetSources();

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const DIGEST_CHECK_MS = 15 * 60 * 1000;
const DIGEST_SEND_MS = 2 * 60 * 60 * 1000;
const STATE_DIRECTORY = process.env.DATA_DIR || path.join(process.cwd(), ".data");
const STATE_FILE = path.join(STATE_DIRECTORY, "push-state.json");

const deviceTokens = new Map();
const pushDevices = new Map();
const seenRowHashes = new Set();
const pendingTeamCounts = new Map();

let baselineInitialized = false;
let lastDigestSentAt = 0;

function persistState() {
  const state = {
    version: 1,
    deviceTokens: [...deviceTokens.entries()],
    pushDevices: [...pushDevices.entries()],
    seenRowHashes: [...seenRowHashes],
    pendingTeamCounts: [...pendingTeamCounts.entries()],
    baselineInitialized,
    lastDigestSentAt
  };

  fs.mkdirSync(STATE_DIRECTORY, { recursive: true });
  const temporaryFile = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(state));
  fs.renameSync(temporaryFile, STATE_FILE);
}

function restoreState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

    for (const entry of state.deviceTokens || []) {
      if (Array.isArray(entry)) {
        deviceTokens.set(entry[0], entry[1] === "sandbox" ? "sandbox" : "production");
      } else if (typeof entry === "string") {
        deviceTokens.set(entry, "production");
      }
    }
    for (const [installId, device] of state.pushDevices || []) pushDevices.set(installId, device);
    for (const hash of state.seenRowHashes || []) seenRowHashes.add(hash);
    for (const [team, count] of state.pendingTeamCounts || []) pendingTeamCounts.set(team, count);
    baselineInitialized = state.baselineInitialized === true && seenRowHashes.size > 0;
    lastDigestSentAt = Number(state.lastDigestSentAt) || 0;

    console.log(
      `State restored: ${deviceTokens.size} iOS devices, ${pushDevices.size} Android devices, ${seenRowHashes.size} rows`
    );
  } catch (error) {
    console.error("state restore error:", error);
  }
}

restoreState();

function getApnsProvider(environment = "production") {
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
    production: environment === "production"
  });
}

function requireAdmin(req, res, next) {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) return next();
  if (req.headers["x-admin-key"] !== adminKey) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

function hashRow(row) {
  return crypto.createHash("sha256").update(row.trim()).digest("hex");
}

function parseCsvRows(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const teamIdx = headers.findIndex((h) => h.includes("team"));
  if (teamIdx === -1) return [];

  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    return { raw: line, team: (cols[teamIdx] || "").trim() };
  }).filter((r) => r.team.length > 0);
}

function isExpoPushToken(token) {
  return typeof token === "string" && /^(ExpoPushToken|ExponentPushToken)\[.+\]$/.test(token);
}

function getSavedGameIds(value) {
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
}

function normalizeAndroidPushDevice(payload = {}) {
  const installId = typeof payload.installId === "string" ? payload.installId.trim() : "";
  const expoPushToken =
    typeof payload.expoPushToken === "string" ? payload.expoPushToken.trim() : "";
  const platform = typeof payload.platform === "string" ? payload.platform.trim() : "";

  if (!installId) return { error: "Missing installId" };
  if (platform !== "android") return { error: "Only android Expo push tokens are supported here" };
  if (!isExpoPushToken(expoPushToken)) return { error: "Invalid Expo push token" };

  return {
    installId,
    platform,
    expoPushToken,
    projectId: payload.projectId || "",
    appVersion: payload.appVersion || "",
    nativeBuildVersion: payload.nativeBuildVersion || "",
    deviceName: payload.deviceName || "",
    osName: payload.osName || "",
    osVersion: payload.osVersion || "",
    timezone: payload.timezone || "",
    savedGameIds: getSavedGameIds(payload.savedGameIds),
    updatedAt: new Date().toISOString()
  };
}

function getAndroidPushDevices() {
  return [...pushDevices.values()].filter((device) => isExpoPushToken(device.expoPushToken));
}

function removeExpoPushToken(token) {
  let changed = false;
  for (const [installId, device] of pushDevices.entries()) {
    if (device.expoPushToken === token) {
      pushDevices.delete(installId);
      changed = true;
    }
  }
  if (changed) persistState();
}

async function sendExpoPushMessages(messages) {
  if (!messages.length) return { sent: 0, tickets: [] };

  const response = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(messages)
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.errors?.[0]?.message || `Expo push failed: ${response.status}`);
  }

  const tickets = Array.isArray(json.data) ? json.data : [json.data].filter(Boolean);
  tickets.forEach((ticket, index) => {
    if (ticket?.status === "error" && ticket?.details?.error === "DeviceNotRegistered") {
      removeExpoPushToken(messages[index]?.to);
    }
  });

  return { sent: messages.length, tickets };
}

async function fetchLatestRows(source) {
  const response = await fetch(source.url);
  if (!response.ok) throw new Error(`${source.sport} sheet fetch failed: ${response.status}`);
  const csv = await response.text();
  return parseCsvRows(csv).map((row) => ({ ...row, sport: source.sport }));
}

async function fetchAllLatestRows() {
  const results = await Promise.allSettled(sheetSources.map(fetchLatestRows));
  const rows = [];

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      rows.push(...result.value);
    } else {
      console.error(`${sheetSources[index].sport} sheet error:`, result.reason);
    }
  });

  if (results.every((result) => result.status === "rejected")) {
    throw new Error("All sheet fetches failed");
  }
  return rows;
}

async function initializeBaselineOnce() {
  if (baselineInitialized) return;
  const rows = await fetchAllLatestRows();
  for (const row of rows) seenRowHashes.add(`${row.sport}:${hashRow(row.raw)}`);
  baselineInitialized = true;
  persistState();
  console.log(`Baseline initialized with ${seenRowHashes.size} rows`);
}

async function collectNewRowsIntoDigest() {
  const rows = await fetchAllLatestRows();
  let changed = false;
  for (const row of rows) {
    const h = `${row.sport}:${hashRow(row.raw)}`;
    if (seenRowHashes.has(h)) continue;
    seenRowHashes.add(h);
    pendingTeamCounts.set(row.team, (pendingTeamCounts.get(row.team) || 0) + 1);
    changed = true;
  }
  if (changed) persistState();
}

function buildDigestBody() {
  const entries = [...pendingTeamCounts.entries()].sort((a, b) => b[1] - a[1]);
  const totalNew = entries.reduce((n, [, c]) => n + c, 0);
  const top3 = entries.slice(0, 3).map(([team]) => team);
  const remaining = Math.max(0, entries.length - 3);
  const safeTotal = totalNew > 999 ? "999+" : String(totalNew);

  if (top3.length === 0) return `${safeTotal} new giveaways added`;
  if (remaining > 0) return `${safeTotal} new giveaways by ${top3.join(", ")} + ${remaining} more`;
  return `${safeTotal} new giveaways by ${top3.join(", ")}`;
}

async function sendDigestIfNeeded() {
  const now = Date.now();
  if (pendingTeamCounts.size === 0) return;
  if (now - lastDigestSentAt < DIGEST_SEND_MS) return;

  const body = buildDigestBody();
  const teams = [...pendingTeamCounts.keys()];

  for (const environment of ["sandbox", "production"]) {
    const tokens = [...deviceTokens.entries()]
      .filter(([, value]) => value === environment)
      .map(([token]) => token);
    if (tokens.length === 0) continue;

    const provider = getApnsProvider(environment);
    for (const token of tokens) {
      const note = new apn.Notification();
      note.topic = process.env.APNS_TOPIC;
      note.alert = { title: "New giveaways added", body };
      note.sound = "default";
      note.payload = {
        type: "new_giveaways_digest",
        teams,
        source: "stadium-signal-api"
      };
      const result = await provider.send(note, token);
      const failure = result.failed?.[0];
      if (["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"].includes(failure?.response?.reason)) {
        deviceTokens.delete(token);
      }
    }
    provider.shutdown();
  }
  persistState();

  const androidMessages = getAndroidPushDevices().map((device) => ({
    to: device.expoPushToken,
    title: "New giveaways added",
    body,
    sound: "default",
    channelId: "default",
    data: {
      type: "new_giveaways_digest",
      tab: "all",
      source: "stadium-signal-api"
    }
  }));
  await sendExpoPushMessages(androidMessages);

  pendingTeamCounts.clear();
  lastDigestSentAt = now;
  persistState();
}

app.get("/health", (_req, res) => res.status(200).send("ok"));

app.get("/api/csv", async (_req, res) => {
  try {
    const response = await fetch(BASEBALL_SHEET_URL);
    if (!response.ok) return res.status(502).json({ ok: false, error: `Sheet fetch failed: ${response.status}` });
    const csv = await response.text();
    return res.type("text/csv").send(csv);
  } catch (error) {
    console.error("csv proxy error:", error);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.post("/api/push/register-device", (req, res) => {
  const { token, platform, environment = "production" } = req.body || {};
  if (!token || !platform) return res.status(400).json({ ok: false, error: "Missing token/platform" });
  if (platform !== "ios") return res.status(400).json({ ok: false, error: "Only ios supported" });
  if (!["sandbox", "production"].includes(environment)) {
    return res.status(400).json({ ok: false, error: "Invalid APNs environment" });
  }
  deviceTokens.set(token, environment);
  persistState();
  return res.status(200).json({ ok: true, registered: deviceTokens.size });
});

app.post("/api/push/register", (req, res) => {
  const device = normalizeAndroidPushDevice(req.body);
  if (device.error) return res.status(400).json({ ok: false, error: device.error });

  pushDevices.set(device.installId, device);
  persistState();
  return res.status(200).json({
    ok: true,
    registered: pushDevices.size,
    installId: device.installId
  });
});

app.post("/api/push/preferences", (req, res) => {
  const device = normalizeAndroidPushDevice(req.body);
  if (device.error) return res.status(400).json({ ok: false, error: device.error });

  const existing = pushDevices.get(device.installId) || {};
  pushDevices.set(device.installId, { ...existing, ...device });
  persistState();
  return res.status(200).json({
    ok: true,
    updated: true,
    installId: device.installId,
    savedGameCount: device.savedGameIds.length
  });
});

app.get("/api/push/tokens", requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    count: deviceTokens.size,
    iosCount: deviceTokens.size,
    androidCount: pushDevices.size
  });
});

app.get("/api/push/sources", requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    checkIntervalMinutes: DIGEST_CHECK_MS / 60_000,
    digestIntervalMinutes: DIGEST_SEND_MS / 60_000,
    sources: sheetSources.map(({ sport }) => sport)
  });
});

app.post("/api/push/test-send", requireAdmin, async (req, res) => {
  try {
    const explicitToken = req.body?.token;
    const explicitEnvironment = req.body?.environment;
    const requestedPlatform = req.body?.platform;
    const title = req.body?.title || "Stadium Signal";
    const body = req.body?.body || "Test push from Railway";

    if (requestedPlatform === "android" || isExpoPushToken(explicitToken)) {
      const token = explicitToken || getAndroidPushDevices()[0]?.expoPushToken;
      if (!token) {
        return res.status(400).json({ ok: false, error: "No Android Expo push token available" });
      }

      const result = await sendExpoPushMessages([
        {
          to: token,
          title,
          body,
          sound: "default",
          channelId: "default",
          data: {
            type: "test",
            tab: "myList",
            source: "stadium-signal-api"
          }
        }
      ]);
      return res.json({ ok: true, platform: "android", result });
    }

    const firstRegistration = deviceTokens.entries().next().value;
    const token = explicitToken || firstRegistration?.[0];
    if (!token) return res.status(400).json({ ok: false, error: "No iOS device token available" });

    const environment = explicitEnvironment || deviceTokens.get(token) || "production";
    const provider = getApnsProvider(environment);
    const note = new apn.Notification();
    note.topic = process.env.APNS_TOPIC;
    note.alert = { title, body };
    note.sound = "default";
    note.payload = { source: "stadium-signal-api" };

    const result = await provider.send(note, token);
    provider.shutdown();
    return res.json({ ok: true, platform: "ios", environment, result });
  } catch (error) {
    console.error("push send error:", error);
    return res.status(500).json({ ok: false, error: error.message || "Push send failed" });
  }
});

initializeBaselineOnce().catch((e) => console.error("baseline init error:", e));

setInterval(async () => {
  try {
    await initializeBaselineOnce();
    await collectNewRowsIntoDigest();
    await sendDigestIfNeeded();
  } catch (e) {
    console.error("digest loop error:", e);
  }
}, DIGEST_CHECK_MS);

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
