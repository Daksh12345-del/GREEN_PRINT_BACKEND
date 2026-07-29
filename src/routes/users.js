const express = require("express");
const bcrypt = require("bcryptjs");
const { query } = require("../lib/db");
const { requireAuth, requireRole, resolveCompanyId } = require("../lib/auth");

const router = express.Router();
router.use(requireAuth);

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, companyId: u.company_id };
}

const ASSIGNABLE_BY_COMPANY_ADMIN = ["plant_manager", "fleet_manager", "employee", "auditor"];

router.get("/", requireRole("company_admin", "super_admin"), async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const result = companyId
      ? await query("SELECT * FROM users WHERE company_id = $1 ORDER BY name", [companyId])
      : await query("SELECT * FROM users ORDER BY name");
    res.json(result.rows.map(publicUser));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong loading users" });
  }
});

router.post("/", requireRole("company_admin", "super_admin"), async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: "Missing required fields: name, email, password, role" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }
    if (req.user.role === "company_admin" && !ASSIGNABLE_BY_COMPANY_ADMIN.includes(role)) {
      return res.status(403).json({ error: `company_admin cannot assign role "${role}"` });
    }

    const companyId = req.user.role === "super_admin" ? req.body.companyId || null : req.user.companyId;

    const existing = await query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "An account with that email already exists" });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const result = await query(
      "INSERT INTO users (name, email, password_hash, role, company_id) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [name, email, passwordHash, role, companyId]
    );
    res.status(201).json(publicUser(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong adding the user" });
  }
});

router.delete("/:id", requireRole("company_admin", "super_admin"), async (req, res) => {
  try {
    if (Number(req.params.id) === req.user.id) {
      return res.status(400).json({ error: "You can't delete your own account" });
    }
    const result = await query("DELETE FROM users WHERE id = $1", [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: "User not found" });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong deleting the user" });
  }
});

module.exports = router;
