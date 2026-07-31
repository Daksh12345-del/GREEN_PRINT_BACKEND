// smoke-test.js
// Runs against a REAL deployed backend (Render), not localhost — this is
// the check that catches "the deploy succeeded but the app is actually
// broken" (wrong env var, database unreachable, crashed on boot, etc.)
// that unit tests can't catch because they never touch production.
//
// Usage:
//   BACKEND_URL=https://green-print-backend.onrender.com node scripts/smoke-test.js
//
// Exits 0 if everything passes, 1 if anything fails — designed to be the
// pass/fail signal a CI workflow (or a human) can check.

const BACKEND_URL = process.env.BACKEND_URL;
const FRONTEND_URL = process.env.FRONTEND_URL; // optional, for the CORS check

if (!BACKEND_URL) {
  console.error("BACKEND_URL environment variable is required, e.g.:");
  console.error("  BACKEND_URL=https://green-print-backend.onrender.com node scripts/smoke-test.js");
  process.exit(1);
}

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`✅ ${label}`);
  } else {
    console.log(`❌ ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

async function main() {
  console.log(`Running smoke test against ${BACKEND_URL}\n`);

  // 1. The server responds at all, and quickly — Render's free tier can
  // be asleep, so give it real time to wake up rather than failing fast.
  let health;
  try {
    const start = Date.now();
    const res = await fetch(`${BACKEND_URL}/api/health`, { signal: AbortSignal.timeout(45000) });
    const elapsedMs = Date.now() - start;
    health = await res.json().catch(() => null);
    check("Backend responds to /api/health", res.status === 200, `got HTTP ${res.status}`);
    check("Response is valid JSON", health !== null);
    if (elapsedMs > 30000) {
      console.log(`   (took ${(elapsedMs / 1000).toFixed(1)}s — this is normal for Render's free tier waking from sleep)`);
    }
  } catch (err) {
    check("Backend responds to /api/health", false, err.message);
  }

  // 2. It's actually talking to a real database, not silently degraded.
  if (health) {
    check("Database is connected (Postgres)", health.database === "supabase-postgres", `got "${health.database}"`);
    check("ok:true in health response", health.ok === true);
    check("AI mode is a recognized value", ["groq", "rule-based fallback"].includes(health.aiMode), `got "${health.aiMode}"`);
  }

  // 3. Auth is actually enforced — an unauthenticated request to a
  // protected route must be rejected, not silently allowed through
  // (which would indicate middleware got misconfigured on deploy).
  try {
    const res = await fetch(`${BACKEND_URL}/api/logs`);
    check("Protected routes reject unauthenticated requests", res.status === 401, `got HTTP ${res.status}`);
  } catch (err) {
    check("Protected routes reject unauthenticated requests", false, err.message);
  }

  // 4. A garbage login is correctly rejected (not a 500 — confirms the
  // auth route + bcrypt + database round-trip all actually work).
  try {
    const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "smoke-test-nonexistent@example.com", password: "wrong" })
    });
    check("Login endpoint handles a bad login correctly", res.status === 401, `got HTTP ${res.status}`);
  } catch (err) {
    check("Login endpoint handles a bad login correctly", false, err.message);
  }

  // 5. CORS is configured for the real frontend, if we were told what it is.
  if (FRONTEND_URL) {
    try {
      const res = await fetch(`${BACKEND_URL}/api/health`, {
        headers: { Origin: FRONTEND_URL }
      });
      const allowOrigin = res.headers.get("access-control-allow-origin");
      check(
        "CORS allows the production frontend's origin",
        allowOrigin === FRONTEND_URL || allowOrigin === "*",
        `Access-Control-Allow-Origin was "${allowOrigin}"`
      );
    } catch (err) {
      check("CORS allows the production frontend's origin", false, err.message);
    }
  }

  console.log("");
  if (failures > 0) {
    console.log(`${failures} check(s) FAILED.`);
    process.exit(1);
  } else {
    console.log("All smoke test checks passed.");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
