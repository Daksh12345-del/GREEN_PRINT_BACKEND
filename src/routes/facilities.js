const express = require("express");
const { query } = require("../lib/db");
const { requireAuth, requireRole, resolveCompanyId } = require("../lib/auth");

const router = express.Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const result = companyId
      ? await query("SELECT * FROM facilities WHERE company_id = $1 ORDER BY name", [companyId])
      : await query("SELECT * FROM facilities ORDER BY name");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong loading facilities" });
  }
});

router.post("/", requireRole("company_admin", "plant_manager", "super_admin"), async (req, res) => {
  try {
    const companyId = resolveCompanyId(req) || req.body.companyId;
    const { name, type } = req.body;
    if (!companyId) return res.status(400).json({ error: "companyId is required" });
    if (!name) return res.status(400).json({ error: "name is required" });

    const result = await query(
      "INSERT INTO facilities (company_id, name, type) VALUES ($1,$2,$3) RETURNING *",
      [companyId, name, type || "Plant"]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong adding the facility" });
  }
});

router.delete("/:id", requireRole("company_admin", "plant_manager", "super_admin"), async (req, res) => {
  try {
    const result = await query("DELETE FROM facilities WHERE id = $1", [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Facility not found" });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong deleting the facility" });
  }
});

module.exports = router;
