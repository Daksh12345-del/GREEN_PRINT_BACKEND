const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { query } = require("../lib/db");
const { signToken, requireAuth } = require("../lib/auth");
const { sendEmail, passwordResetEmail } = require("../lib/email");
const { loginLimiter, forgotPasswordLimiter, registerLimiter } = require("../lib/rateLimit");

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
router.post("/register-company", registerLimiter, async (req, res) => {
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

router.post("/login", loginLimiter, async (req, res) => {
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

// Forgot password — always responds the same way whether or not the
// email exists, so this endpoint can't be used to check who has an
// account (a common security requirement).
router.post("/forgot-password", forgotPasswordLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const result = await query("SELECT * FROM users WHERE email = $1", [email]);
    const user = result.rows[0];

    if (user) {
      const rawToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

      await query(
        "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,$3)",
        [user.id, tokenHash, expiresAt]
      );

      const appUrl = process.env.APP_URL || "http://localhost:5173";
      const resetUrl = `${appUrl}/reset-password?token=${rawToken}`;
      const { subject, text, html } = passwordResetEmail({ resetUrl, userName: user.name });

      try {
        await sendEmail({ to: user.email, subject, text, html });
      } catch (emailErr) {
        // Don't leak email-sending failures to the client — that would
        // reveal whether the address exists. Log it for the operator instead.
        console.error("Failed to send password reset email:", emailErr.message);
      }
    }

    // Same response either way — existent or not.
    res.json({ message: "If that email has an account, a reset link has been sent." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong processing that request" });
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ error: "token and newPassword are required" });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const result = await query(
      "SELECT * FROM password_resets WHERE token_hash = $1",
      [tokenHash]
    );
    const reset = result.rows[0];

    if (!reset) {
      return res.status(400).json({ error: "Invalid or expired reset link" });
    }
    if (reset.used_at) {
      return res.status(400).json({ error: "This reset link has already been used" });
    }
    if (new Date(reset.expires_at) < new Date()) {
      return res.status(400).json({ error: "This reset link has expired — request a new one" });
    }

    const passwordHash = bcrypt.hashSync(newPassword, 10);
    await query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, reset.user_id]);
    await query("UPDATE password_resets SET used_at = now() WHERE id = $1", [reset.id]);

    res.json({ message: "Password updated — you can now sign in with your new password." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong resetting your password" });
  }
});

module.exports = router;
