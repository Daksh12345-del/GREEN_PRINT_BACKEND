// db.js
// Real, cloud-hosted Postgres — your Supabase project. Connects via
// DATABASE_URL (see server/.env). Schema is created automatically on
// startup with idempotent `CREATE TABLE IF NOT EXISTS` statements — see
// supabase-schema.sql for the same statements if you want to run them by
// hand in the Supabase SQL editor first.
//
// IMPORTANT: nothing about emission factors is hardcoded in application
// code. Every conversion factor (CO2e for electricity/fuels, plus NOx/SOx)
// lives in the `emission_factors` table below, sourced from published
// government/standards-body datasets (see seedEmissionFactors() for exact
// citations). A super_admin can add, edit, or add new regions/pollutants
// from the Emission Factors admin page — nothing requires a code change.

const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

if (!process.env.DATABASE_URL) {
  console.error(
    "\nDATABASE_URL is not set. Copy server/.env.example to server/.env and paste in\n" +
    "your Supabase connection string (Project Settings → Database → Connection string → URI).\n"
  );
  process.exit(1);
}

const isLocalDb = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false }
});

async function query(text, params = []) {
  return pool.query(text, params);
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sector TEXT NOT NULL,
  scale TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'GLOBAL',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN (
    'super_admin', 'company_admin', 'plant_manager',
    'fleet_manager', 'employee', 'auditor'
  )),
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS facilities (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Plant',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehicles (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Truck',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every conversion factor the platform uses, sourced and versioned.
-- region: ISO-ish region code the factor applies to ('IN', 'UK', 'US', 'DE', 'FR', 'SG', 'GLOBAL')
-- activity_type: what's being consumed ('electricity', 'diesel', 'petrol', 'natural_gas', 'lpg', 'coal')
-- pollutant: which gas/pollutant this row converts to ('CO2e', 'NOx', 'SOx')
-- unit: the unit of the ACTIVITY quantity this factor multiplies (e.g. 'kWh', 'litre', 'kg')
-- factor_value: kg of the pollutant produced per 1 unit of the activity
CREATE TABLE IF NOT EXISTS emission_factors (
  id SERIAL PRIMARY KEY,
  region TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  pollutant TEXT NOT NULL CHECK (pollutant IN ('CO2e', 'NOx', 'SOx')),
  factor_value REAL NOT NULL,
  unit TEXT NOT NULL,
  source TEXT NOT NULL,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (region, activity_type, pollutant)
);

-- Activity-based logs: what was actually consumed, not a pre-computed number.
-- Emissions are computed by looking up emission_factors for the company's
-- region + activity_type at read time — see src/lib/emissions.js.
CREATE TABLE IF NOT EXISTS logs (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  facility_id INTEGER REFERENCES facilities(id) ON DELETE SET NULL,
  vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
  activity_type TEXT NOT NULL CHECK (activity_type IN (
    'electricity', 'diesel', 'petrol', 'natural_gas', 'lpg', 'coal'
  )),
  quantity REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL,
  renewable_share REAL NOT NULL DEFAULT 0,
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'device')),
  device_id INTEGER,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- IoT / telematics devices that can push activity data directly via API
-- key, instead of a human typing it into the Logs page.
CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  facility_id INTEGER REFERENCES facilities(id) ON DELETE SET NULL,
  vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,
  api_key_prefix TEXT NOT NULL,
  default_activity_type TEXT NOT NULL DEFAULT 'electricity',
  default_unit TEXT NOT NULL DEFAULT 'kWh',
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_insights_cache (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload_json JSONB NOT NULL
);

-- Configurable, platform-wide settings (e.g. carbon credit price per tonne)
-- that a super_admin can change without touching code.
CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A company's declared baseline year emissions, against which the Carbon
-- Credit Estimator measures reductions. This is a per-company, user-set
-- number — not something the platform invents.
CREATE TABLE IF NOT EXISTS carbon_baselines (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  baseline_year INTEGER NOT NULL,
  baseline_tco2e REAL NOT NULL,
  set_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Forgot-password flow. We store a HASH of the reset token, never the
-- token itself — same principle as password_hash. A token is only valid
-- until expires_at and can only be used once (used_at gets set).
CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function migrate() {
  await pool.query(SCHEMA_SQL);

  // Defensive migration: if this database already had `companies` / `logs`
  // tables from an older version of this schema (before region/activity
  // tracking existed), CREATE TABLE IF NOT EXISTS above silently skipped
  // them — it only creates tables that don't exist yet, it never adds
  // columns to ones that already do. These ALTERs backfill any columns a
  // pre-existing table might be missing, safely (existing rows get the
  // DEFAULT value, nothing is deleted).
  await pool.query(`
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'GLOBAL';

    ALTER TABLE logs ADD COLUMN IF NOT EXISTS activity_type TEXT NOT NULL DEFAULT 'electricity';
    ALTER TABLE logs ADD COLUMN IF NOT EXISTS quantity REAL NOT NULL DEFAULT 0;
    ALTER TABLE logs ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT 'kWh';
    ALTER TABLE logs ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
    ALTER TABLE logs ADD COLUMN IF NOT EXISTS device_id INTEGER;
  `);
}

// ---------------------------------------------------------------------------
// Emission factors — real, sourced, published figures. Every row cites
// exactly where the number comes from. A super_admin can add more
// regions/activity types from the Emission Factors admin page at any time;
// this seed just gets you a defensible starting set.
// ---------------------------------------------------------------------------
const EMISSION_FACTOR_SEED = [
  // --- Electricity (grid CO2e), by region ---
  {
    region: "IN", activity_type: "electricity", pollutant: "CO2e", factor_value: 0.710, unit: "kWh",
    source: "Central Electricity Authority (CEA), CO2 Baseline Database v21.0 (Dec 2025)",
    notes: "National weighted-average grid emission factor for FY 2024-25."
  },
  {
    region: "UK", activity_type: "electricity", pollutant: "CO2e", factor_value: 0.131, unit: "kWh",
    source: "UK DEFRA/DESNZ Government GHG Conversion Factors for Company Reporting, 2026",
    notes: "UK grid electricity, location-based."
  },
  {
    region: "DE", activity_type: "electricity", pollutant: "CO2e", factor_value: 0.330, unit: "kWh",
    source: "Ember electricity data, 2025 estimate",
    notes: "Germany grid average — update as newer Ember/national data is published."
  },
  {
    region: "FR", activity_type: "electricity", pollutant: "CO2e", factor_value: 0.041, unit: "kWh",
    source: "Ember electricity data, 2025 estimate",
    notes: "France's nuclear-heavy grid gives one of the lowest factors in Europe."
  },
  {
    region: "SG", activity_type: "electricity", pollutant: "CO2e", factor_value: 0.497, unit: "kWh",
    source: "Ember electricity data, 2025 estimate",
    notes: "Singapore grid average."
  },
  {
    region: "GLOBAL", activity_type: "electricity", pollutant: "CO2e", factor_value: 0.475, unit: "kWh",
    source: "IEA global average electricity emission intensity (approximate)",
    notes: "Fallback only — pick a specific region above whenever you know it."
  },

  // --- Fuel combustion (Scope 1) — CO2e. Fuel chemistry is largely
  // consistent globally, so DEFRA's combustion (not electricity) factors
  // are commonly used worldwide, per CDP/CSRD guidance. ---
  {
    region: "GLOBAL", activity_type: "diesel", pollutant: "CO2e", factor_value: 2.571, unit: "litre",
    source: "UK DEFRA/DESNZ GHG Conversion Factors, 2026 (average biofuel blend, TTW)",
    notes: "Applies globally — fuel combustion chemistry doesn't vary much by country."
  },
  {
    region: "GLOBAL", activity_type: "petrol", pollutant: "CO2e", factor_value: 2.070, unit: "litre",
    source: "UK DEFRA/DESNZ GHG Conversion Factors, 2026",
    notes: null
  },
  {
    region: "GLOBAL", activity_type: "natural_gas", pollutant: "CO2e", factor_value: 0.183, unit: "kWh",
    source: "UK DEFRA/DESNZ GHG Conversion Factors, 2026 (gross CV basis)",
    notes: null
  },
  {
    region: "GLOBAL", activity_type: "lpg", pollutant: "CO2e", factor_value: 1.558, unit: "litre",
    source: "UK DEFRA/DESNZ GHG Conversion Factors, 2026",
    notes: null
  },
  {
    region: "GLOBAL", activity_type: "coal", pollutant: "CO2e", factor_value: 2.403, unit: "kg",
    source: "UK DEFRA/DESNZ GHG Conversion Factors, 2026 (industrial coal, average)",
    notes: null
  },

  // --- NOx / SOx — indicative averages only. These vary a lot by engine
  // / boiler technology and are normally confirmed by site-specific stack
  // testing (EPA AP-42 methodology) for real compliance filings. Treat
  // these as reasonable defaults to override once you have your own
  // measured values. ---
  {
    region: "GLOBAL", activity_type: "diesel", pollutant: "NOx", factor_value: 0.0287, unit: "litre",
    source: "US EPA AP-42 Ch.3 (Diesel Industrial Engines), indicative average",
    notes: "Varies significantly by engine tier/age — replace with stack-test data if available."
  },
  {
    region: "GLOBAL", activity_type: "diesel", pollutant: "SOx", factor_value: 0.0021, unit: "litre",
    source: "US EPA AP-42 Ch.3, indicative average (assumes low-sulfur diesel, ~15ppm S)",
    notes: "Recompute directly from fuel sulfur content (%S) if known — SOx scales linearly with it."
  },
  {
    region: "GLOBAL", activity_type: "coal", pollutant: "NOx", factor_value: 9.0, unit: "kg",
    source: "US EPA AP-42 Ch.1 (external combustion, uncontrolled bituminous coal), indicative average",
    notes: "Per tonne of coal; highly dependent on boiler type and NOx controls."
  },
  {
    region: "GLOBAL", activity_type: "coal", pollutant: "SOx", factor_value: 19.0, unit: "kg",
    source: "US EPA AP-42 Ch.1, indicative average (uncontrolled, ~1-2% sulfur coal)",
    notes: "Recompute from actual coal sulfur content where known — SOx is roughly proportional to it."
  }
];

async function seedEmissionFactors() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM emission_factors");
  if (rows[0].count > 0) return;

  for (const f of EMISSION_FACTOR_SEED) {
    await pool.query(
      `INSERT INTO emission_factors (region, activity_type, pollutant, factor_value, unit, source, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (region, activity_type, pollutant) DO NOTHING`,
      [f.region, f.activity_type, f.pollutant, f.factor_value, f.unit, f.source, f.notes || null]
    );
  }
  console.log(`Seeded ${EMISSION_FACTOR_SEED.length} emission factors (DEFRA 2026 / CEA v21.0 / EPA AP-42).`);
}

async function seedPlatformSettings() {
  await pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`,
    ["carbon_credit_price_usd_per_tco2e", "15"]
  );
}

async function seedDemoData() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM companies");
  if (rows[0].count > 0) return;

  const hash = (pw) => bcrypt.hashSync(pw, 10);

  const acme = (
    await pool.query(
      "INSERT INTO companies (name, sector, scale, region) VALUES ($1,$2,$3,$4) RETURNING id",
      ["Acme Manufacturing", "Manufacturing", "Enterprise", "IN"]
    )
  ).rows[0];
  const swift = (
    await pool.query(
      "INSERT INTO companies (name, sector, scale, region) VALUES ($1,$2,$3,$4) RETURNING id",
      ["Swift Logistics", "Logistics", "Mid-size", "UK"]
    )
  ).rows[0];
  await pool.query("INSERT INTO companies (name, sector, scale, region) VALUES ($1,$2,$3,$4)", [
    "Urban Grid Co.", "Energy", "City Utility", "GLOBAL"
  ]);

  await pool.query(
    `INSERT INTO users (name, email, password_hash, role, company_id) VALUES ($1,$2,$3,$4,$5)`,
    ["Super Admin", "admin@greenprint.io", hash("admin123"), "super_admin", null]
  );
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role, company_id) VALUES ($1,$2,$3,$4,$5)`,
    ["Ava Kapoor", "ava@acme.io", hash("demo1234"), "company_admin", acme.id]
  );
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role, company_id) VALUES ($1,$2,$3,$4,$5)`,
    ["Rohan Mehta", "rohan@acme.io", hash("demo1234"), "plant_manager", acme.id]
  );
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role, company_id) VALUES ($1,$2,$3,$4,$5)`,
    ["Priya Singh", "priya@swift.io", hash("demo1234"), "fleet_manager", swift.id]
  );

  const plant1 = (
    await pool.query(
      "INSERT INTO facilities (company_id, name, type) VALUES ($1,$2,$3) RETURNING id",
      [acme.id, "Plant 1 — Pune", "Plant"]
    )
  ).rows[0];
  await pool.query("INSERT INTO facilities (company_id, name, type) VALUES ($1,$2,$3)", [
    acme.id, "Plant 2 — Nagpur", "Plant"
  ]);

  const truck1 = (
    await pool.query(
      "INSERT INTO vehicles (company_id, name, type) VALUES ($1,$2,$3) RETURNING id",
      [swift.id, "Truck GJ-04-1123", "Truck"]
    )
  ).rows[0];
  await pool.query("INSERT INTO vehicles (company_id, name, type) VALUES ($1,$2,$3)", [
    swift.id, "Truck GJ-04-1187", "Truck"
  ]);

  const now = Date.now();
  const iso = (hoursAgo) => new Date(now - hoursAgo * 3600 * 1000).toISOString();
  const insertLog = (companyId, facilityId, vehicleId, activityType, quantity, unit, renewableShare, hoursAgo) =>
    pool.query(
      `INSERT INTO logs (company_id, facility_id, vehicle_id, activity_type, quantity, unit, renewable_share, timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [companyId, facilityId, vehicleId, activityType, quantity, unit, renewableShare, iso(hoursAgo)]
    );

  await insertLog(acme.id, plant1.id, null, "electricity", 1200, "kWh", 30, 96);
  await insertLog(acme.id, plant1.id, null, "electricity", 1450, "kWh", 28, 48);
  await insertLog(acme.id, plant1.id, null, "diesel", 180, "litre", 0, 24);
  await insertLog(acme.id, plant1.id, null, "electricity", 980, "kWh", 35, 2);
  await insertLog(swift.id, null, truck1.id, "diesel", 220, "litre", 0, 30);
  await insertLog(swift.id, null, truck1.id, "diesel", 165, "litre", 0, 6);

  console.log("Seeded Supabase Postgres with demo companies, users, facilities, vehicles, and logs.");
  console.log("Login as: admin@greenprint.io / admin123 (super admin)");
  console.log("      or: ava@acme.io / demo1234 (company admin, Acme Manufacturing — region: IN)");
}

// ---------------------------------------------------------------------------
// Test-only helpers. Not used by the running app at all — only by the
// automated test suite (see server/tests/) to get a clean, predictable
// database before each test file runs.
// ---------------------------------------------------------------------------

// Wipes every domain table and reseeds the emission factors + platform
// settings (but not demo companies/users — tests create exactly the data
// they need via the API, so results are fully predictable).
async function resetForTests() {
  await pool.query(`
    TRUNCATE companies, users, facilities, vehicles, logs, devices,
             emission_factors, ai_insights_cache, platform_settings, carbon_baselines,
             password_resets
    RESTART IDENTITY CASCADE
  `);
  await seedEmissionFactors();
  await seedPlatformSettings();
}

// Ensures tables exist (idempotent) then wipes/reseeds them. Safe to call
// at the start of every test file, even against a brand-new CI database.
async function prepareTestDb() {
  await migrate();
  await resetForTests();
}

async function init() {
  await migrate();
  await seedEmissionFactors();
  await seedPlatformSettings();
  await seedDemoData();
}

module.exports = { pool, query, init, migrate, resetForTests, prepareTestDb };
