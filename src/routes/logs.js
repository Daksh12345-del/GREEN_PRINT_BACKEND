const express = require("express");
const { query } = require("../lib/db");
const { requireAuth, resolveCompanyId } = require("../lib/auth");
const { loadFactorMap, computeLogEmissions } = require("../lib/emissions");

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

router.get("/activity-types", (req, res) => {
  res.json(ACTIVITY_UNITS);
});

router.get("/", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const result = companyId
      ? await query("SELECT * FROM logs WHERE company_id = $1 ORDER BY timestamp ASC", [companyId])
      : await query("SELECT * FROM logs ORDER BY timestamp ASC");

    const factorMap = await loadFactorMap();
    const regionCache = {};

    const enriched = [];
    for (const row of result.rows) {
      regionCache[row.company_id] ??= await getCompanyRegion(row.company_id);
      const emissions = computeLogEmissions(row, regionCache[row.company_id], factorMap);
      enriched.push({ ...row, emissions });
    }

    res.json(enriched);
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

    const result = await query(
      `INSERT INTO logs (company_id, facility_id, vehicle_id, activity_type, quantity, unit, renewable_share, recorded_by, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual') RETURNING *`,
      [
        companyId,
        facilityId || null,
        vehicleId || null,
        activityType,
        Number(quantity) || 0,
        unit,
        Number(renewableShare) || 0,
        req.user.id
      ]
    );

    const region = await getCompanyRegion(companyId);
    const factorMap = await loadFactorMap();
    const emissions = computeLogEmissions(result.rows[0], region, factorMap);

    res.status(201).json({ ...result.rows[0], emissions });
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
