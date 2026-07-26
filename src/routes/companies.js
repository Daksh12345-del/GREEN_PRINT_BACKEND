const express = require("express");
const { query } = require("../lib/db");
const { requireAuth, requireRole } = require("../lib/auth");

const router = express.Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  try {
    if (req.user.role === "super_admin") {
      const result = await query("SELECT * FROM companies ORDER BY name");
      return res.json(result.rows);
    }
    if (!req.user.companyId) return res.json([]);
    const result = await query("SELECT * FROM companies WHERE id = $1", [req.user.companyId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong loading companies" });
  }
});

router.post("/", requireRole("super_admin"), async (req, res) => {
  try {
    const { name, sector, scale, region } = req.body;
    if (!name || !sector || !scale) {
      return res.status(400).json({ error: "Missing required fields: name, sector, scale" });
    }
    const result = await query(
      "INSERT INTO companies (name, sector, scale, region) VALUES ($1,$2,$3,$4) RETURNING *",
      [name, sector, scale, region || "GLOBAL"]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong creating the company" });
  }
});

// company_admin can update their own company's region (which emission
// factors apply to them) and super_admin can update anyone's.
router.patch("/:id", requireRole("company_admin", "super_admin"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (req.user.role === "company_admin" && id !== req.user.companyId) {
      return res.status(403).json({ error: "You can only update your own company" });
    }
    const { region, sector, scale } = req.body;
    const result = await query(
      `UPDATE companies SET
         region = COALESCE($2, region),
         sector = COALESCE($3, sector),
         scale = COALESCE($4, scale)
       WHERE id = $1 RETURNING *`,
      [id, region || null, sector || null, scale || null]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Company not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong updating the company" });
  }
});

router.delete("/:id", requireRole("super_admin"), async (req, res) => {
  try {
    const result = await query("DELETE FROM companies WHERE id = $1", [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Company not found" });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong deleting the company" });
  }
});

module.exports = router;
