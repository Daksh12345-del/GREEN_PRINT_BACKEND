const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareTestDb } = require("../src/lib/db");
const { startTestServer, stopTestServer, api } = require("./helpers/testServer");

async function registerCompany(base, overrides = {}) {
  const res = await api(base, "POST", "/api/auth/register-company", {
    body: {
      companyName: "Roles Test Co", sector: "Manufacturing", scale: "SME", region: "IN",
      adminName: "Admin", adminEmail: "admin@rolestest.io", adminPassword: "password123",
      ...overrides
    }
  });
  return res.body;
}

test("roles and access control", async (t) => {
  await prepareTestDb();
  const base = await startTestServer();
  const { token: adminToken } = await registerCompany(base);

  await t.test("company_admin CAN create a plant_manager", async () => {
    const res = await api(base, "POST", "/api/users", {
      token: adminToken,
      body: { name: "Plant Guy", email: "plant@rolestest.io", password: "password123", role: "plant_manager" }
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.role, "plant_manager");
  });

  await t.test("company_admin CANNOT create a super_admin (privilege escalation blocked)", async () => {
    const res = await api(base, "POST", "/api/users", {
      token: adminToken,
      body: { name: "Sneaky", email: "sneaky@rolestest.io", password: "password123", role: "super_admin" }
    });
    assert.equal(res.status, 403);
  });

  await t.test("a plant_manager cannot manage the team (only company_admin/super_admin can)", async () => {
    const login = await api(base, "POST", "/api/auth/login", { body: { email: "plant@rolestest.io", password: "password123" } });
    const res = await api(base, "GET", "/api/users", { token: login.body.token });
    assert.equal(res.status, 403);
  });

  await t.test("one company cannot see another company's logs", async () => {
    // Company A logs some activity
    await api(base, "POST", "/api/logs", { token: adminToken, body: { activityType: "electricity", quantity: 500, renewableShare: 10 } });

    // Company B is a totally separate tenant
    const companyB = await registerCompany(base, { companyName: "Other Co", adminEmail: "other@otherco.io" });
    const res = await api(base, "GET", "/api/logs", { token: companyB.token });

    assert.equal(res.status, 200);
    assert.equal(res.body.length, 0, "Company B should not see Company A's logs");
  });

  await t.test("only super_admin can manage emission factors (add/delete)", async () => {
    const res = await api(base, "POST", "/api/emission-factors", {
      token: adminToken,
      body: { region: "XX", activityType: "electricity", pollutant: "CO2e", factorValue: 0.5, unit: "kWh", source: "test" }
    });
    assert.equal(res.status, 403);
  });

  await stopTestServer();
});
