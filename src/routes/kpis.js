const express = require("express");
const { query } = require("../lib/db");
const { requireAuth, resolveCompanyId } = require("../lib/auth");
const { computeKPIs } = require("../lib/emissions");

const router = express.Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);

    if (companyId) {
      const company = (await query("SELECT * FROM companies WHERE id = $1", [companyId])).rows[0];
      if (!company) return res.status(404).json({ error: "Company not found" });
      const logs = (await query("SELECT * FROM logs WHERE company_id = $1", [companyId])).rows;
      return res.json({ region: company.region, ...computeKPIs(logs) });
    }

    // super_admin with no companyId filter: global rollup + per-company breakdown
    const companies = (await query("SELECT * FROM companies ORDER BY name")).rows;
    const allLogs = (await query("SELECT * FROM logs")).rows;

    const byCompany = companies.map((c) => {
      const logs = allLogs.filter((l) => l.company_id === c.id);
      return { companyId: c.id, companyName: c.name, region: c.region, ...computeKPIs(logs) };
    });

    const global = byCompany.reduce(
      (acc, c) => ({
        co2e: acc.co2e + c.co2e,
        nox: acc.nox + c.nox,
        sox: acc.sox + c.sox,
        electricityCo2e: acc.electricityCo2e + c.electricityCo2e,
        fuelCo2e: acc.fuelCo2e + c.fuelCo2e,
        sampleSize: acc.sampleSize + c.sampleSize
      }),
      { co2e: 0, nox: 0, sox: 0, electricityCo2e: 0, fuelCo2e: 0, sampleSize: 0 }
    );

    res.json({ ...global, byCompany });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong computing KPIs" });
  }
});

// Month-over-month comparison, using each log's real timestamp and its
// stored (historically-accurate) CO2e — powers the in-app alert banner
// ("this month is up 23% vs last month"). A configurable threshold
// decides whether it's shown as an alert vs just informational.
const ALERT_THRESHOLD_PERCENT = 20;

router.get("/trend", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json({ error: "companyId is required (super_admin: pass ?companyId=)" });
    }

    const logs = (await query("SELECT * FROM logs WHERE company_id = $1", [companyId])).rows;

    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const previousMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    let currentMonthCo2e = 0;
    let previousMonthCo2e = 0;

    for (const log of logs) {
      const ts = new Date(log.timestamp);
      const co2e = log.co2e_kg || 0;
      if (ts >= currentMonthStart) {
        currentMonthCo2e += co2e;
      } else if (ts >= previousMonthStart && ts < currentMonthStart) {
        previousMonthCo2e += co2e;
      }
    }

    let percentChange = null;
    if (previousMonthCo2e > 0) {
      percentChange = Number((((currentMonthCo2e - previousMonthCo2e) / previousMonthCo2e) * 100).toFixed(1));
    }

    const isAlert = percentChange !== null && percentChange >= ALERT_THRESHOLD_PERCENT;

    res.json({
      currentMonthCo2e: Number(currentMonthCo2e.toFixed(1)),
      previousMonthCo2e: Number(previousMonthCo2e.toFixed(1)),
      percentChange,
      alertThresholdPercent: ALERT_THRESHOLD_PERCENT,
      isAlert,
      message:
        percentChange === null
          ? "Not enough history yet to compare months."
          : isAlert
            ? `This month's emissions are ${percentChange}% higher than last month.`
            : percentChange < 0
              ? `This month's emissions are ${Math.abs(percentChange)}% lower than last month.`
              : `This month's emissions are about the same as last month (${percentChange}% change).`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong computing the trend" });
  }
});

// FUEL_TYPES mirrors routes/logs.js's activity taxonomy — used here only
// to classify a log as Scope 1 (fuel combustion) vs Scope 2 (purchased
// electricity) for the chart breakdowns below. Not an emission factor.
const FUEL_TYPES = ["diesel", "petrol", "natural_gas", "lpg", "coal"];

function periodKey(ts, granularity) {
  const d = new Date(ts);
  if (granularity === "year") return String(d.getFullYear());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function periodLabel(key, granularity) {
  if (granularity === "year") return key;
  const [y, m] = key.split("-");
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

// Monthly or yearly emissions series for the resolved company, split into
// Scope 1 (fuel) / Scope 2 (electricity), built entirely from each log's
// STORED co2e_kg snapshot — same "never recompute on read" rule as
// everywhere else in this codebase (see lib/emissions.js).
router.get("/timeseries", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json({ error: "companyId is required (super_admin: pass ?companyId=)" });
    }
    const granularity = req.query.granularity === "year" ? "year" : "month";

    const logs = (await query(
      "SELECT * FROM logs WHERE company_id = $1 ORDER BY timestamp ASC",
      [companyId]
    )).rows;

    const buckets = new Map();
    for (const log of logs) {
      const key = periodKey(log.timestamp, granularity);
      if (!buckets.has(key)) {
        buckets.set(key, { period: key, label: periodLabel(key, granularity), scope1: 0, scope2: 0, co2e: 0, sampleSize: 0 });
      }
      const bucket = buckets.get(key);
      const co2e = log.co2e_kg || 0;
      if (log.activity_type === "electricity") bucket.scope2 += co2e;
      else if (FUEL_TYPES.includes(log.activity_type)) bucket.scope1 += co2e;
      bucket.co2e += co2e;
      bucket.sampleSize += 1;
    }

    const series = [...buckets.values()]
      .sort((a, b) => a.period.localeCompare(b.period))
      .map((b) => ({
        ...b,
        scope1: Number(b.scope1.toFixed(1)),
        scope2: Number(b.scope2.toFixed(1)),
        co2e: Number(b.co2e.toFixed(1))
      }));

    res.json({ granularity, series });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong computing the timeseries" });
  }
});

// Facility-wise breakdown: sums each facility's stored CO2e and its share
// of the company total. Logs not tied to a facility (fleet/vehicle logs,
// or logs entered before a facility was assigned) are grouped into a
// single "Unassigned / Fleet" bucket rather than silently dropped.
router.get("/by-facility", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json({ error: "companyId is required (super_admin: pass ?companyId=)" });
    }

    const logs = (await query("SELECT * FROM logs WHERE company_id = $1", [companyId])).rows;
    const facilities = (await query(
      "SELECT id, name FROM facilities WHERE company_id = $1",
      [companyId]
    )).rows;
    const facilityNames = new Map(facilities.map((f) => [f.id, f.name]));

    const buckets = new Map();
    let total = 0;

    for (const log of logs) {
      const key = log.facility_id ?? "unassigned";
      const name = log.facility_id ? (facilityNames.get(log.facility_id) || "Deleted facility") : "Unassigned / Fleet";
      if (!buckets.has(key)) {
        buckets.set(key, { facilityId: log.facility_id, facilityName: name, co2e: 0, sampleSize: 0 });
      }
      const bucket = buckets.get(key);
      const co2e = log.co2e_kg || 0;
      bucket.co2e += co2e;
      bucket.sampleSize += 1;
      total += co2e;
    }

    const breakdown = [...buckets.values()]
      .map((b) => ({
        ...b,
        co2e: Number(b.co2e.toFixed(1)),
        percentage: total > 0 ? Number(((b.co2e / total) * 100).toFixed(1)) : 0
      }))
      .sort((a, b) => b.co2e - a.co2e);

    res.json({ total: Number(total.toFixed(1)), breakdown });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong computing the facility breakdown" });
  }
});

// Minimum OTHER companies (with at least one log) required in a sector
// before we'll show a sector average. Below this, even an "average" is
// really just one or two competitors' numbers with extra steps — showing
// it would de-anonymize them. Exported for the test suite.
const MIN_PEERS_FOR_BENCHMARK = 3;

// Sector benchmark: "how does your company compare to others in your
// sector" — fully anonymized (no peer company names, IDs, or individual
// numbers ever leave this endpoint, only an aggregate average and your
// own percentile rank within it).
//
// Deliberately NOT based on raw total CO2e: a 10-person workshop and a
// 500-person factory in "Manufacturing" would never be comparable on
// that basis, and this app doesn't collect production volume/revenue to
// normalize by (see HONESTY.md). Instead this compares two metrics that
// are meaningful regardless of company size:
//   - Green Score (0-100, already a normalized composite — see emissions.js)
//   - Renewable electricity share (%, inherently size-independent)
// co2ePerLog (average CO2e per logged activity) is also shown as a rough,
// clearly-labeled intensity signal, not a ranking metric.
router.get("/benchmark", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json({ error: "companyId is required (super_admin: pass ?companyId=)" });
    }

    const company = (await query("SELECT * FROM companies WHERE id = $1", [companyId])).rows[0];
    if (!company) return res.status(404).json({ error: "Company not found" });

    const ownLogs = (await query("SELECT * FROM logs WHERE company_id = $1", [companyId])).rows;
    const ownKpis = computeKPIs(ownLogs);

    const peers = (
      await query("SELECT id FROM companies WHERE sector = $1 AND id != $2", [company.sector, companyId])
    ).rows;
    const peerIds = peers.map((p) => p.id);

    const peerLogs = peerIds.length
      ? (await query("SELECT * FROM logs WHERE company_id = ANY($1::int[])", [peerIds])).rows
      : [];

    const logsByCompany = new Map();
    for (const log of peerLogs) {
      if (!logsByCompany.has(log.company_id)) logsByCompany.set(log.company_id, []);
      logsByCompany.get(log.company_id).push(log);
    }

    // Only peers who've actually logged something count — an empty
    // company would just drag the average toward its default 50 score.
    const peerKpisList = [...logsByCompany.values()]
      .map((logs) => computeKPIs(logs))
      .filter((k) => k.sampleSize > 0);

    if (peerKpisList.length < MIN_PEERS_FOR_BENCHMARK) {
      return res.json({
        available: false,
        sector: company.sector,
        peerCount: peerKpisList.length,
        minPeersRequired: MIN_PEERS_FOR_BENCHMARK,
        message:
          `Not enough other companies in "${company.sector}" have logged activity yet to show an ` +
          `anonymized average (need at least ${MIN_PEERS_FOR_BENCHMARK}; currently ${peerKpisList.length}).`
      });
    }

    const avg = (nums) => nums.reduce((a, b) => a + b, 0) / nums.length;

    const sectorAvgGreenScore = avg(peerKpisList.map((k) => k.esgScore));
    const sectorAvgRenewableShare = avg(peerKpisList.map((k) => k.renewableShare));
    const sectorAvgCo2ePerLog = avg(peerKpisList.map((k) => k.co2e / k.sampleSize));

    const ownCo2ePerLog = ownKpis.sampleSize > 0 ? ownKpis.co2e / ownKpis.sampleSize : 0;

    // Percentile = share of the full sector (peers + you) whose Green
    // Score you meet or beat. Higher percentile = greener than more peers.
    const allScores = [...peerKpisList.map((k) => k.esgScore), ownKpis.esgScore];
    const percentile = Math.round(
      (allScores.filter((s) => s <= ownKpis.esgScore).length / allScores.length) * 100
    );

    res.json({
      available: true,
      sector: company.sector,
      peerCount: peerKpisList.length,
      minPeersRequired: MIN_PEERS_FOR_BENCHMARK,
      percentile,
      yourCompany: {
        greenScore: ownKpis.esgScore,
        renewableShare: ownKpis.renewableShare,
        co2ePerLog: Number(ownCo2ePerLog.toFixed(1)),
        sampleSize: ownKpis.sampleSize
      },
      sectorAverage: {
        greenScore: Math.round(sectorAvgGreenScore),
        renewableShare: Number(sectorAvgRenewableShare.toFixed(1)),
        co2ePerLog: Number(sectorAvgCo2ePerLog.toFixed(1))
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong computing the sector benchmark" });
  }
});

module.exports = router;
