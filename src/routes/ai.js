const express = require("express");
const { query } = require("../lib/db");
const { requireAuth, resolveCompanyId } = require("../lib/auth");
const { computeKPIs } = require("../lib/emissions");
const { generateRecommendations } = require("../lib/aiEngine");

const router = express.Router();
router.use(requireAuth);

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — avoid hammering the API on every dashboard poll

router.get("/insights", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json({ error: "companyId is required (super_admin: pass ?companyId=)" });
    }

    const forceRefresh = req.query.refresh === "true";

    if (!forceRefresh) {
      const cached = (
        await query(
          `SELECT * FROM ai_insights_cache WHERE company_id = $1 ORDER BY generated_at DESC LIMIT 1`,
          [companyId]
        )
      ).rows[0];
      if (cached && Date.now() - new Date(cached.generated_at).getTime() < CACHE_TTL_MS) {
        return res.json({ ...cached.payload_json, cached: true });
      }
    }

    const company = (await query("SELECT * FROM companies WHERE id = $1", [companyId])).rows[0];
    if (!company) return res.status(404).json({ error: "Company not found" });

    const logs = (await query("SELECT * FROM logs WHERE company_id = $1", [companyId])).rows;
    const recentLogs = (
      await query("SELECT * FROM logs WHERE company_id = $1 ORDER BY timestamp DESC LIMIT 10", [companyId])
    ).rows;
    const facilities = (await query("SELECT * FROM facilities WHERE company_id = $1", [companyId])).rows;
    const vehicles = (await query("SELECT * FROM vehicles WHERE company_id = $1", [companyId])).rows;

    const kpis = computeKPIs(logs);
    const result = await generateRecommendations({ company, kpis, recentLogs, facilities, vehicles });

    await query(
      `INSERT INTO ai_insights_cache (company_id, source, payload_json) VALUES ($1,$2,$3)`,
      [companyId, result.source, JSON.stringify(result)]
    );

    res.json({ ...result, cached: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong generating insights" });
  }
});

module.exports = router;
