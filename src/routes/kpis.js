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

module.exports = router;
