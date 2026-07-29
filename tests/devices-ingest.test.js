const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareTestDb } = require("../src/lib/db");
const { startTestServer, stopTestServer, api } = require("./helpers/testServer");

test("IoT devices and ingestion", async (t) => {
  await prepareTestDb();
  const base = await startTestServer();

  const { token } = (await api(base, "POST", "/api/auth/register-company", {
    body: {
      companyName: "IoT Test Co", sector: "Manufacturing", scale: "SME", region: "IN",
      adminName: "Admin", adminEmail: "admin@iottest.io", adminPassword: "password123"
    }
  })).body;

  let apiKey;

  await t.test("company_admin can create a device and receives a real API key", async () => {
    const res = await api(base, "POST", "/api/devices", {
      token, body: { name: "Test Meter", defaultActivityType: "electricity", defaultUnit: "kWh" }
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.apiKey && res.body.apiKey.startsWith("gp_live_"));
    apiKey = res.body.apiKey;
  });

  await t.test("the device can push a reading using ONLY its API key — no user login involved", async () => {
    const res = await fetch(`${base}/api/ingest/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ quantity: 250, renewableShare: 15 })
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.source, "device");
    // 250 kWh * 0.710 (India factor) = 177.5
    assert.equal(body.emissions.CO2e, 177.5);
  });

  await t.test("an invalid API key is rejected with 401", async () => {
    const res = await fetch(`${base}/api/ingest/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "gp_live_totally_made_up" },
      body: JSON.stringify({ quantity: 100 })
    });
    assert.equal(res.status, 401);
  });

  await t.test("a missing API key is rejected with 401", async () => {
    const res = await fetch(`${base}/api/ingest/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity: 100 })
    });
    assert.equal(res.status, 401);
  });

  await t.test("the device-sourced log shows up in the company's regular log list", async () => {
    const res = await api(base, "GET", "/api/logs", { token });
    const deviceLogs = res.body.filter((l) => l.source === "device");
    assert.equal(deviceLogs.length, 1);
  });

  await stopTestServer();
});
