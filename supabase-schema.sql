-- Green Print schema for Supabase Postgres.
--
-- You do NOT have to run this by hand — the server creates these tables
-- automatically on first start (see src/lib/db.js, which runs the exact
-- same statements, then seeds emission factors and demo data). This file
-- exists so you can paste it into the Supabase SQL Editor if you want to
-- see the tables appear immediately, before ever starting the Node server.
--
-- Note: emission factor and demo seed DATA is not in this file — that
-- lives in src/lib/db.js (EMISSION_FACTOR_SEED) since it's inserted via
-- parameterized queries, not raw SQL. Start the server once to populate it.

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
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  co2e_kg REAL,
  nox_kg REAL,
  sox_kg REAL,
  factors_snapshot JSONB
);

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

CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS carbon_baselines (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  baseline_year INTEGER NOT NULL,
  baseline_tco2e REAL NOT NULL,
  set_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
