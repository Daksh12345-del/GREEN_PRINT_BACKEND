const express = require("express");
const { query } = require("../lib/db");
const { requireAuth, resolveCompanyId } = require("../lib/auth");
const { loadFactorMap, computeLogEmissions, snapshotForStorage, readSnapshot } = require("../lib/emissions");

const router = express.Router();
router.use(requireAuth);

// Unit taxonomy only (NOT an emission factor) — this just tells the UI
// which unit each activity type is measured in, so a diesel log can't
// accidentally be entered in kWh. The actual kg-per-unit conversion always
// comes from the emission_factors table, never from here.
const ACTIVITY_UNITS = {
  electricity: "kWh",
  diesel: "litre",
  petrol: "litre",
  natural_gas: "kWh",
  lpg: "litre",
  coal: "kg"
};

async function getCompanyRegion(companyId) {
  const { rows } = await query("SELECT region FROM companies WHERE id = $1", [companyId]);
  return rows[0]?.region || "GLOBAL";
}

function withEmissions(row) {
  return { ...row, emissions: readSnapshot(row) };
}

router.get("/activity-types", (req, res) => {
  res.json(ACTIVITY_UNITS);
});

// Reads NEVER touch emission_factors or recompute anything — every log's
// emissions were calculated once, at write time, and are permanently
// stored on the row (co2e_kg/nox_kg/sox_kg/factors_snapshot). This is
// what makes historical numbers immune to future factor updates.
router.get("/", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const result = companyId
      ? await query("SELECT * FROM logs WHERE company_id = $1 ORDER BY timestamp ASC", [companyId])
      : await query("SELECT * FROM logs ORDER BY timestamp ASC");

    res.json(result.rows.map(withEmissions));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong loading logs" });
  }
});

router.post("/", async (req, res) => {
  try {
    const companyId = req.user.role === "super_admin" ? req.body.companyId : req.user.companyId;
    if (!companyId) return res.status(400).json({ error: "companyId is required" });

    const { facilityId, vehicleId, activityType, quantity, renewableShare } = req.body;

    if (!ACTIVITY_UNITS[activityType]) {
      return res.status(400).json({
        error: `activityType must be one of: ${Object.keys(ACTIVITY_UNITS).join(", ")}`
      });
    }

    const unit = ACTIVITY_UNITS[activityType];
    const quantityNum = Number(quantity) || 0;
    const renewableShareNum = Number(renewableShare) || 0;

    // Compute emissions ONCE, right now, against today's factors — then
    // store the result permanently. This log will show this exact number
    // forever, even if the underlying factor changes later.
    const region = await getCompanyRegion(companyId);
    const factorMap = await loadFactorMap();
    const emissions = computeLogEmissions(
      { activity_type: activityType, quantity: quantityNum },
      region,
      factorMap
    );
    const snap = snapshotForStorage(emissions);

    const result = await query(
      `INSERT INTO logs (
         company_id, facility_id, vehicle_id, activity_type, quantity, unit,
         renewable_share, recorded_by, source, co2e_kg, nox_kg, sox_kg, factors_snapshot
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual',$9,$10,$11,$12) RETURNING *`,
      [
        companyId,
        facilityId || null,
        vehicleId || null,
        activityType,
        quantityNum,
        unit,
        renewableShareNum,
        req.user.id,
        snap.co2eKg,
        snap.noxKg,
        snap.soxKg,
        snap.factorsSnapshot
      ]
    );

    res.status(201).json(withEmissions(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong saving the log" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const existing = await query("SELECT * FROM logs WHERE id = $1", [req.params.id]);
    const row = existing.rows[0];
    if (!row) return res.status(404).json({ error: "Log not found" });

    const companyId = resolveCompanyId(req);
    if (companyId && row.company_id !== companyId) {
      return res.status(403).json({ error: "That log doesn't belong to your company" });
    }

    await query("DELETE FROM logs WHERE id = $1", [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong deleting the log" });
  }
});

module.exports = router;
