# Testing the Green Print backend

```bash
npm test
```

Runs the full test suite (`tests/`) using Node's built-in test runner —
no extra test framework dependency, nothing to install beyond the
regular `npm install`.

## What's covered

| File | What it verifies |
|---|---|
| `tests/auth.test.js` | Registration, login, duplicate-email rejection, `/me` |
| `tests/password-reset.test.js` | Forgot-password never leaks whether an email exists, tokens expire after 15 min, are single-use, and a real reset actually changes the login-able password |
| `tests/rate-limiting.test.js` | Login is blocked with 429 after repeated attempts (brute-force protection), forgot-password is blocked after repeated requests (anti-spam), and rate limiting is scoped only to the endpoints that need it |
| `tests/factor-versioning.test.js` | **The core proof for historical accuracy** — logs an activity, changes the underlying factor to a very different value, confirms the original log's number didn't move, and confirms a brand-new log picks up the changed factor |
| `tests/trend.test.js` | Month-over-month CO2e comparison math, using controlled timestamps, and that the 20% alert threshold fires correctly |
| `tests/roles.test.js` | Role-based access control — company_admin can't self-escalate to super_admin, one company can't see another's data, only super_admin manages emission factors |
| `tests/emissions.test.js` | **The core differentiator** — region-specific factors produce different, exact numbers (India vs UK electricity), multi-pollutant output (NOx/SOx), GLOBAL fallback for unseeded regions |
| `tests/kpis.test.js` | Dashboard rollup math across multiple mixed-activity logs |
| `tests/devices-ingest.test.js` | IoT device creation + real API-key-authenticated ingestion (not JWT), invalid/missing key rejection |
| `tests/carbon-credits.test.js` | Baseline + estimate math, the "not certified" disclaimer is always present, reduction never goes negative |
| `tests/reports.test.js` | The PDF endpoint returns an actual valid PDF (checks the `%PDF-` magic header and a realistic file size), requires auth |

## Requirements

A real Postgres `DATABASE_URL` — a local instance is fine and recommended
for testing. **Never point this at your real Supabase project** — the
test suite truncates and reseeds tables on every run (`prepareTestDb()`
in `src/lib/db.js`), which would wipe real data.

```bash
# example local setup
createdb greenprint_test
export DATABASE_URL="postgresql://postgres:yourpassword@localhost:5432/greenprint_test"
export JWT_SECRET="any-string-for-testing"
npm test
```

## How it works

Each test file:
1. Calls `prepareTestDb()` — creates tables if missing, wipes all domain
   tables, reseeds emission factors + platform settings
2. Starts the real Express app (`server.js`'s exported `app`) on a random
   local port via `tests/helpers/testServer.js`
3. Drives it with real HTTP requests (`fetch`) — the exact same code
   path a real browser or API client would hit, nothing mocked
4. Shuts the server down when done

## CI

See `.github/workflows/ci.yml` — runs this same suite against a real,
ephemeral Postgres service container on every push/PR to `main`.
