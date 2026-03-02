const fs = require("fs");
const path = require("path");

module.exports = async function handler(req, res) {
  try {
    const csvPath = path.join(process.cwd(), "promos.csv");
    const csv = fs.readFileSync(csvPath, "utf8");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    return res.status(200).send(csv);
  } catch (error) {
    return res.status(500).json({ ok: false, error: "Failed to read CSV" });
  }
};
