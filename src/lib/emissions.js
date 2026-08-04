// emissions.js
// Every conversion factor used here comes from the `emission_factors`
// table (see src/lib/db.js for the seed and its citations) — nothing is
// hardcoded in this file.
//
// HISTORICAL FACTOR VERSIONING: computeLogEmissions() is only ever called
// ONCE per log, at the moment it's written (see routes/logs.js and
// routes/ingest.js) — its result is permanently stored on the log row
// itself (co2e_kg, nox_kg, sox_kg, factors_snapshot). Every read
// afterwards (dashboard, AI insights, PDF reports) uses that stored
// snapshot via computeKPIs()/readSnapshot(), NOT a fresh lookup against
// emission_factors. This is deliberate: if CEA/DEFRA republish an updated
// factor next year, a log from last year must keep showing the number
// that was true when it was recorded — it must never silently change
// just because someone edited the Emission Factors page today.

const { query } = require("./db");

// Loads every emission factor row into a lookup map:
//   factors["IN"]["electricity"]["CO2e"] = { factor_value, unit, source, ... }
// Falls back to the "GLOBAL" region for any (activity_type, pollutant)
// combination the company's own region doesn't have a row for.
// Only used at WRITE time (a new log is being created).
async function loadFactorMap() {
  const { rows } = await query("SELECT * FROM emission_factors");
  const map = {};
  for (const row of rows) {
    map[row.region] ??= {};
    map[row.region][row.activity_type] ??= {};
    map[row.region][row.activity_type][row.pollutant] = row;
  }
  return map;
}

function findFactor(map, region, activityType, pollutant) {
  return map[region]?.[activityType]?.[pollutant] || map.GLOBAL?.[activityType]?.[pollutant] || null;
}

// Computes { CO2e, NOx, SOx, factorsUsed } (kg) for one log, against
// CURRENT emission factors. Called exactly once, when the log is first
// written — the result then gets stored permanently (see
// snapshotForStorage() below), never recomputed on read.
function computeLogEmissions(log, region, factorMap) {
  const pollutants = ["CO2e", "NOx", "SOx"];
  const result = {};
  const factorsUsed = [];

  for (const pollutant of pollutants) {
    const factor = findFactor(factorMap, region, log.activity_type, pollutant);
    if (!factor) continue;
    const value = Number((log.quantity * factor.factor_value).toFixed(3));
    result[pollutant] = value;
    factorsUsed.push({
      pollutant,
      factorValue: factor.factor_value,
      unit: factor.unit,
      source: factor.source,
      region: factor.region
    });
  }

  return { ...result, factorsUsed };
}

// Shapes a freshly-computed emissions result into the columns that get
// stored on the log row at INSERT time.
function snapshotForStorage(emissions) {
  return {
    co2eKg: emissions.CO2e ?? null,
    noxKg: emissions.NOx ?? null,
    soxKg: emissions.SOx ?? null,
    factorsSnapshot: JSON.stringify(emissions.factorsUsed)
  };
}

// Reshapes a log row's STORED snapshot columns back into the same
// { CO2e, NOx, SOx, factorsUsed } shape the frontend/PDF report expect —
// this is what every read path uses instead of recomputing.
function readSnapshot(logRow) {
  const result = {};
  if (logRow.co2e_kg !== null && logRow.co2e_kg !== undefined) result.CO2e = logRow.co2e_kg;
  if (logRow.nox_kg !== null && logRow.nox_kg !== undefined) result.NOx = logRow.nox_kg;
  if (logRow.sox_kg !== null && logRow.sox_kg !== undefined) result.SOx = logRow.sox_kg;
  result.factorsUsed = logRow.factors_snapshot || [];
  return result;
}

// Computes KPI rollups from a list of log rows using their STORED
// snapshots — no region or factor map needed here at all, which is the
// whole point: reads never touch emission_factors, only writes do.
function computeKPIs(logs) {
  if (logs.length === 0) {
    return {
      co2e: 0, nox: 0, sox: 0,
      electricityCo2e: 0, fuelCo2e: 0,
      renewableShare: 0, esgScore: 50, sampleSize: 0
    };
  }

  let co2e = 0, nox = 0, sox = 0;
  let electricityCo2e = 0, fuelCo2e = 0;
  let totalRenewableWeighted = 0;
  let electricityCount = 0;

  for (const log of logs) {
    const emissions = readSnapshot(log);
    co2e += emissions.CO2e || 0;
    nox += emissions.NOx || 0;
    sox += emissions.SOx || 0;

    if (log.activity_type === "electricity") {
      electricityCo2e += emissions.CO2e || 0;
      totalRenewableWeighted += log.renewable_share || 0;
      electricityCount += 1;
    } else {
      fuelCo2e += emissions.CO2e || 0;
    }
  }

  const avgRenewable = electricityCount > 0 ? totalRenewableWeighted / electricityCount : 0;

  // Transparent, documented ESG formula (illustrative, not a certified
  // standard — see ROADMAP.md) — rewards renewable share, penalizes total
  // CO2e. Shown as math so it can always be explained, not a black box.
  let esg = 50 + avgRenewable / 2 - co2e / 5000;
  esg = Math.max(0, Math.min(100, esg));

  return {
    co2e: Number(co2e.toFixed(1)),
    nox: Number(nox.toFixed(2)),
    sox: Number(sox.toFixed(2)),
    electricityCo2e: Number(electricityCo2e.toFixed(1)),
    fuelCo2e: Number(fuelCo2e.toFixed(1)),
    renewableShare: Number(avgRenewable.toFixed(1)),
    esgScore: Math.round(esg),
    sampleSize: logs.length
  };
}

// One-time backfill for logs that existed before this snapshot columns
// feature shipped (their co2e_kg etc. are NULL from the ALTER TABLE
// default). We have no record of what the factors were when they were
// originally logged, so — clearly documented tradeoff — this backfill
// uses TODAY's current factors as the best available approximation,
// exactly once. Any log created after this feature shipped never goes
// through this path; it's snapshotted correctly at write time forever.
async function backfillMissingSnapshots() {
  const { rows: pending } = await query(
    "SELECT l.*, c.region AS company_region FROM logs l JOIN companies c ON c.id = l.company_id WHERE l.co2e_kg IS NULL"
  );
  if (pending.length === 0) return;

  const factorMap = await loadFactorMap();
  for (const log of pending) {
    const emissions = computeLogEmissions(log, log.company_region, factorMap);
    const snap = snapshotForStorage(emissions);
    await query(
      "UPDATE logs SET co2e_kg = $1, nox_kg = $2, sox_kg = $3, factors_snapshot = $4 WHERE id = $5",
      [snap.co2eKg, snap.noxKg, snap.soxKg, snap.factorsSnapshot, log.id]
    );
  }
  console.log(`Backfilled emission snapshots for ${pending.length} pre-existing log(s) using current factors.`);
}

module.exports = {
  loadFactorMap,
  findFactor,
  computeLogEmissions,
  snapshotForStorage,
  readSnapshot,
  computeKPIs,
  backfillMissingSnapshots
};
