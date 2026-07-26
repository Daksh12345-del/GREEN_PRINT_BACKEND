const express = require("express");
const bcrypt = require("bcryptjs");
const { query } = require("../lib/db");
const { signToken, requireAuth } = require("../lib/auth");

const router = express.Router();

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    companyId: user.company_id
  };
}

// Self-serve signup: creates a new company AND its first company_admin user.
router.post("/register-company", async (req, res) => {
  try {
    const { companyName, sector, scale, region, adminName, adminEmail, adminPassword } = req.body;

    if (!companyName || !sector || !scale || !adminName || !adminEmail || !adminPassword) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    if (adminPassword.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const existing = await query("SELECT id FROM users WHERE email = $1", [adminEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "An account with that email already exists" });
    }

    const company = (
      await query(
        "INSERT INTO companies (name, sector, scale, region) VALUES ($1,$2,$3,$4) RETURNING *",
        [companyName, sector, scale, region || "GLOBAL"]
      )
    ).rows[0];

    const passwordHash = bcrypt.hashSync(adminPassword, 10);
    const user = (
      await query(
        `INSERT INTO users (name, email, password_hash, role, company_id)
         VALUES ($1,$2,$3,'company_admin',$4) RETURNING *`,
        [adminName, adminEmail, passwordHash, company.id]
      )
    ).rows[0];

    const token = signToken(user);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong creating your account" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const result = await query("SELECT * FROM users WHERE email = $1", [email]);
    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: "Incorrect email or password" });
    }

    const token = signToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong signing in" });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const result = await query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });

    let company = null;
    if (user.company_id) {
      company = (await query("SELECT * FROM companies WHERE id = $1", [user.company_id])).rows[0] || null;
    }

    res.json({ user: publicUser(user), company });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong loading your profile" });
  }
});

module.exports = router;
