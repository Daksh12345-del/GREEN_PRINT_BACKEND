const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareTestDb, query } = require("../src/lib/db");
const { startTestServer, stopTestServer, api } = require("./helpers/testServer");

test("month-over-month trend", async (t) => {
  await prepareTestDb();
  const base = await startTestServer();

  const { token } = (await api(base, "POST", "/api/auth/register-company", {
    body: {
      companyName: "Trend Test Co", sector: "Manufacturing", scale: "SME", region: "IN",
      adminName: "Admin", adminEmail: "admin@trendtest.io", adminPassword: "password123"
    }
  })).body;

  await t.test("with no logs at all, trend says there's not enough history", async () => {
    const res = await api(base, "GET", "/api/kpis/trend", { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.percentChange, null);
    assert.equal(res.body.isAlert, false);
  });

  await t.test("a 50% increase this month vs last month triggers the alert", async () => {
    const meRes = await api(base, "GET", "/api/auth/me", { token });
    const companyId = meRes.body.company.id;

    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 5);

    // Insert directly so we control the exact timestamp (the real API
    // always uses now()).
    await query(
      `INSERT INTO logs (company_id, activity_type, quantity, unit, renewable_share, source, co2e_kg, timestamp)
       VALUES ($1,'electricity',1000,'kWh',0,'manual',100,$2)`,
      [companyId, lastMonth]
    );
    await query(
      `INSERT INTO logs (company_id, activity_type, quantity, unit, renewable_share, source, co2e_kg, timestamp)
       VALUES ($1,'electricity',1000,'kWh',0,'manual',150,$2)`,
      [companyId, thisMonth]
    );

    const res = await api(base, "GET", "/api/kpis/trend", { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.previousMonthCo2e, 100);
    assert.equal(res.body.currentMonthCo2e, 150);
    assert.equal(res.body.percentChange, 50);
    assert.equal(res.body.isAlert, true, "50% increase should cross the alert threshold");
    assert.match(res.body.message, /higher than last month/i);
  });

  await stopTestServer();
});
