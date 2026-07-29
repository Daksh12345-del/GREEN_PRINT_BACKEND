const express = require("express");
const { query } = require("../lib/db");
const { requireAuth, resolveCompanyId } = require("../lib/auth");
const { loadFactorMap, computeKPIs } = require("../lib/emissions");

const router = express.Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const factorMap = await loadFactorMap();

    if (companyId) {
      const company = (await query("SELECT * FROM companies WHERE id = $1", [companyId])).rows[0];
      if (!company) return res.status(404).json({ error: "Company not found" });
      const logs = (await query("SELECT * FROM logs WHERE company_id = $1", [companyId])).rows;
      return res.json({ region: company.region, ...computeKPIs(logs, company.region, factorMap) });
    }

    // super_admin with no companyId filter: global rollup + per-company breakdown
    const companies = (await query("SELECT * FROM companies ORDER BY name")).rows;
    const allLogs = (await query("SELECT * FROM logs")).rows;

    const byCompany = companies.map((c) => {
      const logs = allLogs.filter((l) => l.company_id === c.id);
      return { companyId: c.id, companyName: c.name, region: c.region, ...computeKPIs(logs, c.region, factorMap) };
    });

    // Global rollup: each company's logs computed with its OWN region factors,
    // then summed — not all logs computed against one region (that would be wrong).
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

module.exports = router;
