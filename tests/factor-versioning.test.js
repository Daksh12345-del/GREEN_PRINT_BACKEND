const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareTestDb } = require("../src/lib/db");
const { startTestServer, stopTestServer, api } = require("./helpers/testServer");

test("historical factor versioning", async (t) => {
  await prepareTestDb();
  const base = await startTestServer();

  const { token: adminToken } = (await api(base, "POST", "/api/auth/register-company", {
    body: {
      companyName: "Versioning Test Co", sector: "Manufacturing", scale: "SME", region: "IN",
      adminName: "Admin", adminEmail: "admin@versioningtest.io", adminPassword: "password123"
    }
  })).body;

  const { token: superToken } = (await api(base, "POST", "/api/auth/login", {
    body: { email: "admin@greenprint.io", password: "admin123" }
  })).body;
  // super_admin doesn't exist in a fresh test DB (only demo seed creates
  // it) — register one indirectly isn't possible via the API by design,
  // so this test instead uses the company_admin's own inability to edit
  // factors as the access-control side, and focuses purely on the
  // read-after-write-after-update behavior below using a direct DB edit
  // for the factor change (simulating what a super_admin would do via
  // the Emission Factors page).
  void superToken;

  let firstLogId;
  let firstLogCo2e;

  await t.test("log an activity and record its emissions under the ORIGINAL factor", async () => {
    const res = await api(base, "POST", "/api/logs", {
      token: adminToken, body: { activityType: "diesel", quantity: 100, renewableShare: 0 }
    });
    assert.equal(res.status, 201);
    firstLogId = res.body.id;
    firstLogCo2e = res.body.emissions.CO2e;
    // 100 litres * 2.571 kg/litre (seeded DEFRA diesel factor) = 257.1
    assert.equal(firstLogCo2e, 257.1);
  });

  await t.test("change the diesel factor to something very different", async () => {
    const { query } = require("../src/lib/db");
    await query(
      "UPDATE emission_factors SET factor_value = 999 WHERE region = 'GLOBAL' AND activity_type = 'diesel' AND pollutant = 'CO2e'"
    );
    const check = await query(
      "SELECT factor_value FROM emission_factors WHERE region = 'GLOBAL' AND activity_type = 'diesel' AND pollutant = 'CO2e'"
    );
    assert.equal(Number(check.rows[0].factor_value), 999);
  });

  await t.test("the ORIGINAL log's emissions are unchanged after the factor update", async () => {
    const res = await api(base, "GET", "/api/logs", { token: adminToken });
    const original = res.body.find((l) => l.id === firstLogId);
    assert.ok(original, "original log should still exist");
    assert.equal(
      original.emissions.CO2e,
      firstLogCo2e,
      "historical log must keep showing the factor that was true when it was logged"
    );
  });

  await t.test("a NEW log created after the update uses the NEW factor", async () => {
    const res = await api(base, "POST", "/api/logs", {
      token: adminToken, body: { activityType: "diesel", quantity: 100, renewableShare: 0 }
    });
    assert.equal(res.status, 201);
    // 100 litres * 999 kg/litre (the just-updated factor) = 99900
    assert.equal(res.body.emissions.CO2e, 99900);
    assert.notEqual(res.body.emissions.CO2e, firstLogCo2e);
  });

  await t.test("KPI rollups reflect each log's own stored snapshot, not a recompute", async () => {
    const res = await api(base, "GET", "/api/kpis", { token: adminToken });
    // Sum of the two logs' actual stored values: 257.1 + 99900
    assert.equal(res.body.fuelCo2e, Number((257.1 + 99900).toFixed(1)));
  });

  await stopTestServer();
});
