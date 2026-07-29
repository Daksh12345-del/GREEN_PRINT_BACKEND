const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareTestDb } = require("../src/lib/db");
const { startTestServer, stopTestServer, api } = require("./helpers/testServer");

async function registerCompany(base, region, email) {
  const res = await api(base, "POST", "/api/auth/register-company", {
    body: {
      companyName: `${region} Test Co`, sector: "Manufacturing", scale: "SME", region,
      adminName: "Admin", adminEmail: email, adminPassword: "password123"
    }
  });
  return res.body.token;
}

test("emission factor math is real, configurable, and region-aware", async (t) => {
  await prepareTestDb();
  const base = await startTestServer();

  await t.test("India electricity uses the seeded CEA factor (0.710 kg CO2e/kWh)", async () => {
    const token = await registerCompany(base, "IN", "in@factortest.io");
    const res = await api(base, "POST", "/api/logs", {
      token, body: { activityType: "electricity", quantity: 1000, renewableShare: 0 }
    });
    assert.equal(res.status, 201);
    // 1000 kWh * 0.710 kg/kWh = 710 kg CO2e — this is the exact CEA v21.0 figure, not a guess
    assert.equal(res.body.emissions.CO2e, 710);
  });

  await t.test("UK electricity uses a DIFFERENT seeded factor (0.131 kg CO2e/kWh) for the same quantity", async () => {
    const token = await registerCompany(base, "UK", "uk@factortest.io");
    const res = await api(base, "POST", "/api/logs", {
      token, body: { activityType: "electricity", quantity: 1000, renewableShare: 0 }
    });
    assert.equal(res.status, 201);
    // 1000 kWh * 0.131 kg/kWh = 131 kg CO2e — proves the region actually changes the math
    assert.equal(res.body.emissions.CO2e, 131);
  });

  await t.test("diesel combustion emits NOx and SOx too, not just CO2e", async () => {
    const token = await registerCompany(base, "IN", "diesel@factortest.io");
    const res = await api(base, "POST", "/api/logs", {
      token, body: { activityType: "diesel", quantity: 100, renewableShare: 0 }
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.emissions.CO2e > 0);
    assert.ok(res.body.emissions.NOx > 0, "expected NOx to be computed for diesel");
    assert.ok(res.body.emissions.SOx > 0, "expected SOx to be computed for diesel");
  });

  await t.test("an unrecognized region falls back to the GLOBAL factor instead of erroring", async () => {
    const token = await registerCompany(base, "BRAZIL_NOT_SEEDED", "br@factortest.io");
    const res = await api(base, "POST", "/api/logs", {
      token, body: { activityType: "diesel", quantity: 50, renewableShare: 0 }
    });
    assert.equal(res.status, 201);
    // Diesel is seeded under GLOBAL, so even an unknown region should still get a real number
    assert.ok(res.body.emissions.CO2e > 0);
  });

  await stopTestServer();
});
