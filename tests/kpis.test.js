const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareTestDb } = require("../src/lib/db");
const { startTestServer, stopTestServer, api } = require("./helpers/testServer");

test("KPI rollups", async (t) => {
  await prepareTestDb();
  const base = await startTestServer();

  const { token } = (await api(base, "POST", "/api/auth/register-company", {
    body: {
      companyName: "KPI Test Co", sector: "Manufacturing", scale: "SME", region: "IN",
      adminName: "Admin", adminEmail: "admin@kpitest.io", adminPassword: "password123"
    }
  })).body;

  await t.test("KPIs are all zero with no logs", async () => {
    const res = await api(base, "GET", "/api/kpis", { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.co2e, 0);
    assert.equal(res.body.sampleSize, 0);
  });

  await t.test("KPIs correctly sum across multiple logs of different activity types", async () => {
    await api(base, "POST", "/api/logs", { token, body: { activityType: "electricity", quantity: 1000, renewableShare: 40 } });
    await api(base, "POST", "/api/logs", { token, body: { activityType: "electricity", quantity: 500, renewableShare: 20 } });
    await api(base, "POST", "/api/logs", { token, body: { activityType: "diesel", quantity: 100, renewableShare: 0 } });

    const res = await api(base, "GET", "/api/kpis", { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.sampleSize, 3);

    // electricityCo2e should be (1000+500) * 0.710 = 1065
    assert.equal(res.body.electricityCo2e, 1065);
    // fuelCo2e should be 100 * 2.571 = 257.1
    assert.equal(res.body.fuelCo2e, 257.1);
    // renewable share is averaged only over electricity logs: (40+20)/2 = 30
    assert.equal(res.body.renewableShare, 30);
    // total co2e is the sum of both
    assert.equal(res.body.co2e, 1065 + 257.1);
  });

  await t.test("Green Score stays within 0-100 bounds", async () => {
    const res = await api(base, "GET", "/api/kpis", { token });
    assert.ok(res.body.esgScore >= 0 && res.body.esgScore <= 100);
  });

  await stopTestServer();
});
