const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareTestDb } = require("../src/lib/db");
const { startTestServer, stopTestServer, api } = require("./helpers/testServer");

test("carbon credit estimator", async (t) => {
  await prepareTestDb();
  const base = await startTestServer();

  const { token } = (await api(base, "POST", "/api/auth/register-company", {
    body: {
      companyName: "Credits Test Co", sector: "Manufacturing", scale: "SME", region: "IN",
      adminName: "Admin", adminEmail: "admin@creditstest.io", adminPassword: "password123"
    }
  })).body;

  await t.test("with no baseline set, the response says so instead of guessing", async () => {
    const res = await api(base, "GET", "/api/carbon-credits", { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.hasBaseline, false);
  });

  await t.test("always includes the not-certified disclaimer", async () => {
    const res = await api(base, "GET", "/api/carbon-credits", { token });
    assert.match(res.body.disclaimer, /not an issued or tradeable carbon credit/i);
  });

  await t.test("setting a baseline and logging less than it computes a positive reduction estimate", async () => {
    await api(base, "POST", "/api/carbon-credits/baseline", {
      token, body: { baselineYear: 2024, baselineTco2e: 10 }
    });
    // Log something small relative to the 10-tonne baseline
    await api(base, "POST", "/api/logs", { token, body: { activityType: "electricity", quantity: 100, renewableShare: 50 } });

    const res = await api(base, "GET", "/api/carbon-credits", { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.hasBaseline, true);
    assert.equal(res.body.baselineTco2e, 10);
    assert.ok(res.body.reductionTco2e > 0);
    assert.equal(res.body.estimatedValueUsd, Number((res.body.reductionTco2e * res.body.pricePerTonneUsd).toFixed(2)));
  });

  await t.test("emitting MORE than the baseline never produces a negative reduction", async () => {
    await api(base, "POST", "/api/carbon-credits/baseline", {
      token, body: { baselineYear: 2024, baselineTco2e: 0.001 } // absurdly low baseline
    });
    const res = await api(base, "GET", "/api/carbon-credits", { token });
    assert.ok(res.body.reductionTco2e >= 0, "reduction should be clamped at 0, never negative");
  });

  await stopTestServer();
});
