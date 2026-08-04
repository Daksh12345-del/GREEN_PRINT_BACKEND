const express = require("express");
const crypto = require("crypto");
const { query } = require("../lib/db");
const { loadFactorMap, computeLogEmissions, snapshotForStorage, readSnapshot } = require("../lib/emissions");

const router = express.Router();

// Deliberately NOT using requireAuth (JWT) here — a sensor or telematics
// device authenticates with its own API key instead of a human's login
// token. This is what makes Phase-3 "real-time data" possible: a device
// can call this endpoint directly, with no user in the loop at all.
async function requireDeviceKey(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(401).json({ error: "Missing X-API-Key header" });

  const hash = crypto.createHash("sha256").update(apiKey).digest("hex");
  const result = await query("SELECT * FROM devices WHERE api_key_hash = $1", [hash]);
  const device = result.rows[0];
  if (!device) return res.status(401).json({ error: "Invalid API key" });

  req.device = device;
  next();
}

// A device pushes one activity reading at a time — e.g. a smart meter
// reporting kWh consumed in the last interval, or a fuel-flow sensor
// reporting litres burned. No human types anything.
router.post("/logs", requireDeviceKey, async (req, res) => {
  try {
    const device = req.device;
    const activityType = req.body.activityType || device.default_activity_type;
    const unit = req.body.unit || device.default_unit;
    const quantity = Number(req.body.quantity);
    const renewableShare = Number(req.body.renewableShare) || 0;

    if (!Number.isFinite(quantity) || quantity < 0) {
      return res.status(400).json({ error: "quantity must be a non-negative number" });
    }

    const company = (await query("SELECT region FROM companies WHERE id = $1", [device.company_id])).rows[0];
    const factorMap = await loadFactorMap();
    const emissions = computeLogEmissions({ activity_type: activityType, quantity }, company.region, factorMap);
    const snap = snapshotForStorage(emissions);

    const result = await query(
      `INSERT INTO logs (
         company_id, facility_id, vehicle_id, activity_type, quantity, unit,
         renewable_share, source, device_id, co2e_kg, nox_kg, sox_kg, factors_snapshot
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,'device',$8,$9,$10,$11,$12) RETURNING *`,
      [
        device.company_id,
        device.facility_id,
        device.vehicle_id,
        activityType,
        quantity,
        unit,
        renewableShare,
        device.id,
        snap.co2eKg,
        snap.noxKg,
        snap.soxKg,
        snap.factorsSnapshot
      ]
    );

    await query("UPDATE devices SET last_seen_at = now() WHERE id = $1", [device.id]);

    res.status(201).json({ ...result.rows[0], emissions: readSnapshot(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong ingesting the reading" });
  }
});

module.exports = router;
