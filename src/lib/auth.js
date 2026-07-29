// auth.js
// JWT-based authentication and role-based authorization middleware.

const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "dev-only-secret-change-me";
const TOKEN_TTL = "12h";

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, companyId: user.company_id },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

// Reads "Authorization: Bearer <token>", verifies it, and attaches
// req.user = { id, role, companyId }. Rejects with 401 if missing/invalid.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.id, role: payload.role, companyId: payload.companyId };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Usage: requireRole("company_admin", "super_admin")
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "You don't have permission to do that" });
    }
    next();
  };
}

// Resolves which company_id a request should be scoped to.
// - super_admin may pass ?companyId= to look at a specific company,
//   or omit it to mean "all companies" (routes decide how to handle that).
// - everyone else is locked to their own company_id from the token.
function resolveCompanyId(req) {
  if (req.user.role === "super_admin") {
    return req.query.companyId ? Number(req.query.companyId) : null;
  }
  return req.user.companyId;
}

module.exports = { signToken, requireAuth, requireRole, resolveCompanyId, JWT_SECRET };
