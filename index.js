const express = require("express");
const apn = require("apn");

const app = express();
app.use(express.json());

const SHEET_URL =
process.env.GOOGLE_SHEET_CSV_URL ||
"https://docs.google.com/spreadsheets/d/e/2PACX-1vTrbyTTdk5GP8_dUIifaPtvavCFbTvSk1PHGAiLYqcZIWteTf25nz-wjrq2e8LGYYKXxmPumSUxGCW0/pub?gid=485285881&single=true&output=csv";

const DIGEST_CHECK_MS = 15 * 60 * 1000;     // check every 15m
const DIGEST_SEND_MS = 2 * 60 * 60 * 1000;  // send every 2h

const deviceTokens = new Set();
const seenRowHashes = new Set();
const pendingTeamCounts = new Map();

let baselineInitialized = false;
let lastDigestSentAt = 0;

function getApnsProvider() {
const rawKey = process.env.APNS_P8_KEY;
const key = rawKey ? rawKey.replace(/\n/g, "\n") : null;

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
if (!adminKey) return next(); // optional
if (req.headers["x-admin-key"] !== adminKey) {
return res.status(401).json({ ok: false, error: "Unauthorized" });

}
next();
}

function hashRow(row) {
return row.trim();
}

function parseCsvRows(csv) {
const lines = csv.split(/\r?\n/).filter(Boolean);
if (lines.length < 2) return [];
const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
const teamIdx = headers.findIndex((h) => h.includes("team"));
if (teamIdx === -1) return [];

return lines
.slice(1)

.map((line) => {

  const cols = line.split(",");

  return {

    raw: line,

    team: (cols[teamIdx] || "").trim()

  };

})

.filter((r) => r.team.length > 0);

}

async function fetchLatestRows() {
const response = await fetch(SHEET_URL);
if (!response.ok) throw new Error(Sheet fetch failed: ${response​.status});
const csv = await response.text();
return parseCsvRows(csv);
}

async function initializeBaselineOnce() {
if (baselineInitialized) return;
const rows = await fetchLatestRows();
for (const row of rows) {
seenRowHashes.add(hashRow(row.raw));

}
baselineInitialized = true;
console.log(Baseline initialized with ${seen​Row​Hashes​.size} rows);
}

async function collectNewRowsIntoDigest() {
const rows = await fetchLatestRows();
for (const row of rows) {
const h = hashRow(row.raw);

if (seenRowHashes.has(h)) continue;

seenRowHashes.add(h);

pendingTeamCounts.set(row.team, (pendingTeamCounts.get(row.team) || 0) + 1);

}
}

function buildDigestBody() {
const entries = [...pendingTeamCounts.entries()].sort((a, b) => b[1] - a[1]);
const totalNew = entries.reduce((n, [, c]) => n + c, 0);
const top3 = entries.slice(0, 3).map(([team]) => team);
const remaining = Math.max(0, entries.length - 3);
const safeTotal = totalNew > 999 ? "999+" : String(totalNew);

if (top3.length === 0) return ${safe​Total} new giveaways added;
if (remaining > 0) {
return `${safeTotal} new giveaways by ${top3.join(", ")} + ${remaining} more`;

}
return ${safe​Total} new giveaways by ${top3​.join(", ")};
}

async function sendDigestIfNeeded() {
const now = Date.now();
if (pendingTeamCounts.size === 0) return;
if (now - lastDigestSentAt < DIGEST_SEND_MS) return;

const provider = getApnsProvider();
const body = buildDigestBody();

for (const token of deviceTokens) {
const note = new apn.Notification();

note.topic = process.env.APNS_TOPIC;

note.alert = { title: "New giveaways added", body };

note.sound = "default";

await provider.send(note, token);

}

provider.shutdown();
pendingTeamCounts.clear();
lastDigestSentAt = now;
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

note.topic = process.env.APNS_TOPIC;

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

// Initialize baseline once so first run does not spam users.
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
app.listen(PORT, "0.0.0.0", () => console.log(Listening on ${​PORT}));
