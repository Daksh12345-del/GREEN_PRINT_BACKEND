const express = require("express");
const crypto = require("crypto");
const { query } = require("../lib/db");
const { requireAuth, requireRole, resolveCompanyId } = require("../lib/auth");

const router = express.Router();
router.use(requireAuth);

function generateApiKey() {
  const secret = crypto.randomBytes(24).toString("hex");
  const fullKey = `gp_live_${secret}`;
  const hash = crypto.createHash("sha256").update(fullKey).digest("hex");
  const prefix = fullKey.slice(0, 14) + "…"; // shown in the UI so a device can be recognized without re-showing the secret
  return { fullKey, hash, prefix };
}

router.get("/", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const result = companyId
      ? await query(
          "SELECT id, company_id, facility_id, vehicle_id, name, api_key_prefix, default_activity_type, default_unit, last_seen_at, created_at FROM devices WHERE company_id = $1 ORDER BY name",
          [companyId]
        )
      : await query(
          "SELECT id, company_id, facility_id, vehicle_id, name, api_key_prefix, default_activity_type, default_unit, last_seen_at, created_at FROM devices ORDER BY name"
        );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong loading devices" });
  }
});

router.post("/", requireRole("company_admin", "plant_manager", "fleet_manager", "super_admin"), async (req, res) => {
  try {
    const companyId = resolveCompanyId(req) || req.body.companyId;
    const { name, facilityId, vehicleId, defaultActivityType, defaultUnit } = req.body;
    if (!companyId) return res.status(400).json({ error: "companyId is required" });
    if (!name) return res.status(400).json({ error: "name is required" });

    const { fullKey, hash, prefix } = generateApiKey();

    const result = await query(
      `INSERT INTO devices (company_id, facility_id, vehicle_id, name, api_key_hash, api_key_prefix, default_activity_type, default_unit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, company_id, facility_id, vehicle_id, name, api_key_prefix, default_activity_type, default_unit, created_at`,
      [
        companyId,
        facilityId || null,
        vehicleId || null,
        name,
        hash,
        prefix,
        defaultActivityType || "electricity",
        defaultUnit || "kWh"
      ]
    );

    // The full API key is only ever shown here, once, at creation time —
    // exactly like a real cloud provider's access keys. If it's lost, the
    // device has to be deleted and re-created.
    res.status(201).json({ ...result.rows[0], apiKey: fullKey });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong creating the device" });
  }
});

router.delete("/:id", requireRole("company_admin", "plant_manager", "fleet_manager", "super_admin"), async (req, res) => {
  try {
    const result = await query("DELETE FROM devices WHERE id = $1", [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Device not found" });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong deleting the device" });
  }
});

module.exports = router;
