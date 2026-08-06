const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { prepareTestDb, query } = require("../src/lib/db");
const { startTestServer, stopTestServer, api } = require("./helpers/testServer");

test("kpi breakdowns: timeseries and by-facility", async (t) => {
  await prepareTestDb();
  const base = await startTestServer();

  const { token } = (await api(base, "POST", "/api/auth/register-company", {
    body: {
      companyName: "Breakdown Test Co", sector: "Manufacturing", scale: "SME", region: "IN",
      adminName: "Admin", adminEmail: "admin@breakdowntest.io", adminPassword: "password123"
    }
  })).body;

  const meRes = await api(base, "GET", "/api/auth/me", { token });
  const companyId = meRes.body.company.id;

  const facA = (await api(base, "POST", "/api/facilities", { token, body: { name: "Plant A", type: "Plant" } })).body;
  const facB = (await api(base, "POST", "/api/facilities", { token, body: { name: "Plant B", type: "Plant" } })).body;

  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 10);
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 5);

  // Plant A: electricity (Scope 2) in both months
  await query(
    `INSERT INTO logs (company_id, facility_id, activity_type, quantity, unit, renewable_share, source, co2e_kg, timestamp)
     VALUES ($1,$2,'electricity',1000,'kWh',0,'manual',100,$3)`,
    [companyId, facA.id, lastMonth]
  );
  await query(
    `INSERT INTO logs (company_id, facility_id, activity_type, quantity, unit, renewable_share, source, co2e_kg, timestamp)
     VALUES ($1,$2,'electricity',1000,'kWh',0,'manual',80,$3)`,
    [companyId, facA.id, thisMonth]
  );

  // Plant B: diesel (Scope 1) this month
  await query(
    `INSERT INTO logs (company_id, facility_id, activity_type, quantity, unit, renewable_share, source, co2e_kg, timestamp)
     VALUES ($1,$2,'diesel',50,'litre',0,'manual',60,$3)`,
    [companyId, facB.id, thisMonth]
  );

  // Unassigned (no facility): diesel this month
  await query(
    `INSERT INTO logs (company_id, activity_type, quantity, unit, renewable_share, source, co2e_kg, timestamp)
     VALUES ($1,'diesel',20,'litre',0,'manual',10,$2)`,
    [companyId, thisMonth]
  );

  await t.test("timeseries (monthly) splits scope1/scope2 correctly per bucket", async () => {
    const res = await api(base, "GET", "/api/kpis/timeseries?granularity=month", { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.granularity, "month");
    assert.equal(res.body.series.length, 2, "expected exactly two monthly buckets");

    const last = res.body.series.find((s) => s.co2e === 100);
    const curr = res.body.series.find((s) => s.co2e === 150);
    assert.ok(last, "last month's bucket should total 100 CO2e");
    assert.equal(last.scope2, 100);
    assert.equal(last.scope1, 0);

    assert.ok(curr, "this month's bucket should total 150 CO2e (80 electricity + 60 diesel + 10 diesel)");
    assert.equal(curr.scope2, 80);
    assert.equal(curr.scope1, 70);
  });

  await t.test("timeseries (yearly) collapses into a single bucket when both months are the same year", async () => {
    const res = await api(base, "GET", "/api/kpis/timeseries?granularity=year", { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.granularity, "year");
    // Both synthetic dates fall in the current year unless the test runs in January.
    const yearTotal = res.body.series.reduce((sum, s) => sum + s.co2e, 0);
    assert.equal(Number(yearTotal.toFixed(1)), 250);
  });

  await t.test("by-facility groups correctly and computes percentages", async () => {
    const res = await api(base, "GET", "/api/kpis/by-facility", { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 250);
    assert.equal(res.body.breakdown.length, 3, "Plant A, Plant B, and Unassigned");

    const plantA = res.body.breakdown.find((b) => b.facilityName === "Plant A");
    const plantB = res.body.breakdown.find((b) => b.facilityName === "Plant B");
    const unassigned = res.body.breakdown.find((b) => b.facilityName === "Unassigned / Fleet");

    assert.equal(plantA.co2e, 180);
    assert.equal(plantB.co2e, 60);
    assert.equal(unassigned.co2e, 10);
    assert.equal(plantA.percentage, 72); // 180/250
    assert.ok(
      res.body.breakdown[0].facilityName === "Plant A",
      "results should be sorted descending by co2e"
    );
  });

  await t.test("timeseries and by-facility both require companyId for super_admin", async () => {
    // resetForTests() deliberately doesn't seed a super_admin (see db.js) —
    // tests create exactly the data they need, so insert one directly here.
    await query(
      `INSERT INTO users (name, email, password_hash, role, company_id) VALUES ($1,$2,$3,'super_admin',NULL)`,
      ["Test Super Admin", "super@breakdowntest.io", bcrypt.hashSync("password123", 10)]
    );
    const superLogin = await api(base, "POST", "/api/auth/login", {
      body: { email: "super@breakdowntest.io", password: "password123" }
    });
    assert.equal(superLogin.status, 200);
    const superToken = superLogin.body.token;

    const noCompanyTimeseries = await api(base, "GET", "/api/kpis/timeseries", { token: superToken });
    assert.equal(noCompanyTimeseries.status, 400);

    const noCompanyFacility = await api(base, "GET", "/api/kpis/by-facility", { token: superToken });
    assert.equal(noCompanyFacility.status, 400);

    const scoped = await api(base, "GET", `/api/kpis/timeseries?companyId=${companyId}`, { token: superToken });
    assert.equal(scoped.status, 200, "super_admin CAN view a specific company's timeseries via ?companyId=");
  });

  await stopTestServer();
});
