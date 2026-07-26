const express = require("express");
const { query } = require("../lib/db");
const { requireAuth, requireRole } = require("../lib/auth");

const router = express.Router();
router.use(requireAuth);

// Anyone signed in can VIEW the factors — transparency about exactly what
// number produced their numbers is the point. Only super_admin can add,
// edit, or delete them, since these are meant to be official published
// figures, not something any one company can quietly change.
router.get("/", async (req, res) => {
  try {
    const result = await query(
      "SELECT * FROM emission_factors ORDER BY region, activity_type, pollutant"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong loading emission factors" });
  }
});

router.post("/", requireRole("super_admin"), async (req, res) => {
  try {
    const { region, activityType, pollutant, factorValue, unit, source, notes } = req.body;
    if (!region || !activityType || !pollutant || factorValue === undefined || !unit || !source) {
      return res.status(400).json({
        error: "Missing required fields: region, activityType, pollutant, factorValue, unit, source"
      });
    }
    if (!["CO2e", "NOx", "SOx"].includes(pollutant)) {
      return res.status(400).json({ error: "pollutant must be one of: CO2e, NOx, SOx" });
    }

    const result = await query(
      `INSERT INTO emission_factors (region, activity_type, pollutant, factor_value, unit, source, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (region, activity_type, pollutant)
       DO UPDATE SET factor_value = $4, unit = $5, source = $6, notes = $7, updated_at = now()
       RETURNING *`,
      [region.toUpperCase(), activityType, pollutant, Number(factorValue), unit, source, notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong saving the emission factor" });
  }
});

router.delete("/:id", requireRole("super_admin"), async (req, res) => {
  try {
    const result = await query("DELETE FROM emission_factors WHERE id = $1", [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Emission factor not found" });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong deleting the emission factor" });
  }
});

module.exports = router;
