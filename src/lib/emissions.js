// emissions.js
// Every conversion factor used here comes from the `emission_factors`
// table (see src/lib/db.js for the seed and its citations) — nothing is
// hardcoded in this file. This module just does the lookup + math + the
// documented ESG scoring formula.

const { query } = require("./db");

// Loads every emission factor row into a lookup map:
//   factors["IN"]["electricity"]["CO2e"] = { factor_value, unit, source, ... }
// Falls back to the "GLOBAL" region for any (activity_type, pollutant)
// combination the company's own region doesn't have a row for.
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

// Computes { CO2e, NOx, SOx, factorsUsed } (kg) for one log row, given the
// full factor map and the company's region. Any pollutant with no matching
// factor is simply omitted (not zero-filled, so it's clear it's "unknown"
// rather than "zero emissions").
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

// Computes KPI rollups from a list of raw log rows + the company's region.
// Requires an already-loaded factorMap (call loadFactorMap() once per
// request and pass it in, rather than re-querying per log).
function computeKPIs(logs, region, factorMap) {
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
    const emissions = computeLogEmissions(log, region, factorMap);
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

module.exports = { loadFactorMap, findFactor, computeLogEmissions, computeKPIs };
