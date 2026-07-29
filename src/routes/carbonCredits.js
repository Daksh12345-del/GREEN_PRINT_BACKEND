const express = require("express");
const { query } = require("../lib/db");
const { requireAuth, requireRole, resolveCompanyId } = require("../lib/auth");
const { loadFactorMap, computeKPIs } = require("../lib/emissions");

const router = express.Router();
router.use(requireAuth);

const DISCLAIMER =
  "This is an unaudited estimate for internal planning only. It is NOT an issued or " +
  "tradeable carbon credit — actual credits can only be issued by a recognized registry " +
  "(e.g. Verra, Gold Standard) after third-party verification of your baseline and reductions.";

async function getPricePerTonne() {
  const result = await query(
    "SELECT value FROM platform_settings WHERE key = 'carbon_credit_price_usd_per_tco2e'"
  );
  return Number(result.rows[0]?.value) || 0;
}

router.get("/", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json({ error: "companyId is required (super_admin: pass ?companyId=)" });
    }

    const company = (await query("SELECT * FROM companies WHERE id = $1", [companyId])).rows[0];
    if (!company) return res.status(404).json({ error: "Company not found" });

    const baseline = (
      await query("SELECT * FROM carbon_baselines WHERE company_id = $1", [companyId])
    ).rows[0];

    const logs = (await query("SELECT * FROM logs WHERE company_id = $1", [companyId])).rows;
    const factorMap = await loadFactorMap();
    const kpis = computeKPIs(logs, company.region, factorMap);
    const currentTco2e = kpis.co2e / 1000;

    const pricePerTonne = await getPricePerTonne();

    if (!baseline) {
      return res.json({
        hasBaseline: false,
        currentTco2e: Number(currentTco2e.toFixed(3)),
        pricePerTonneUsd: pricePerTonne,
        disclaimer: DISCLAIMER,
        message: "Set a baseline year and baseline emissions to estimate reductions."
      });
    }

    const reductionTco2e = Math.max(0, baseline.baseline_tco2e - currentTco2e);
    const estimatedValueUsd = reductionTco2e * pricePerTonne;

    res.json({
      hasBaseline: true,
      baselineYear: baseline.baseline_year,
      baselineTco2e: baseline.baseline_tco2e,
      currentTco2e: Number(currentTco2e.toFixed(3)),
      reductionTco2e: Number(reductionTco2e.toFixed(3)),
      pricePerTonneUsd: pricePerTonne,
      estimatedValueUsd: Number(estimatedValueUsd.toFixed(2)),
      disclaimer: DISCLAIMER
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong estimating carbon credits" });
  }
});

router.post("/baseline", requireRole("company_admin", "super_admin"), async (req, res) => {
  try {
    const companyId = req.user.role === "super_admin" ? req.body.companyId : req.user.companyId;
    const { baselineYear, baselineTco2e } = req.body;
    if (!companyId) return res.status(400).json({ error: "companyId is required" });
    if (!baselineYear || baselineTco2e === undefined) {
      return res.status(400).json({ error: "baselineYear and baselineTco2e are required" });
    }

    const result = await query(
      `INSERT INTO carbon_baselines (company_id, baseline_year, baseline_tco2e, set_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (company_id)
       DO UPDATE SET baseline_year = $2, baseline_tco2e = $3, set_by = $4, updated_at = now()
       RETURNING *`,
      [companyId, Number(baselineYear), Number(baselineTco2e), req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong saving the baseline" });
  }
});

// super_admin controls the platform-wide indicative price used in the
// estimate — configurable, not hardcoded.
router.patch("/price", requireRole("super_admin"), async (req, res) => {
  try {
    const { pricePerTonneUsd } = req.body;
    if (pricePerTonneUsd === undefined) {
      return res.status(400).json({ error: "pricePerTonneUsd is required" });
    }
    await query(
      `INSERT INTO platform_settings (key, value) VALUES ('carbon_credit_price_usd_per_tco2e', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
      [String(pricePerTonneUsd)]
    );
    res.json({ pricePerTonneUsd: Number(pricePerTonneUsd) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong updating the price" });
  }
});

module.exports = router;
