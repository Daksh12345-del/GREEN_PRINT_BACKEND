const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareTestDb } = require("../src/lib/db");
const { startTestServer, stopTestServer, api } = require("./helpers/testServer");

test("auth", async (t) => {
  await prepareTestDb();
  const base = await startTestServer();

  await t.test("register-company creates a company + company_admin, returns a working token", async () => {
    const res = await api(base, "POST", "/api/auth/register-company", {
      body: {
        companyName: "Test Manufacturing", sector: "Manufacturing", scale: "SME", region: "IN",
        adminName: "Priya Test", adminEmail: "priya@testco.io", adminPassword: "password123"
      }
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.token, "expected a JWT in the response");
    assert.equal(res.body.user.role, "company_admin");
    assert.equal(res.body.user.email, "priya@testco.io");
  });

  await t.test("duplicate email is rejected with 409", async () => {
    const res = await api(base, "POST", "/api/auth/register-company", {
      body: {
        companyName: "Another Co", sector: "Logistics", scale: "SME", region: "UK",
        adminName: "Someone", adminEmail: "priya@testco.io", adminPassword: "password123"
      }
    });
    assert.equal(res.status, 409);
  });

  await t.test("login with correct credentials succeeds", async () => {
    const res = await api(base, "POST", "/api/auth/login", {
      body: { email: "priya@testco.io", password: "password123" }
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
  });

  await t.test("login with wrong password is rejected with 401", async () => {
    const res = await api(base, "POST", "/api/auth/login", {
      body: { email: "priya@testco.io", password: "totally-wrong" }
    });
    assert.equal(res.status, 401);
  });

  await t.test("/api/auth/me requires a token", async () => {
    const res = await api(base, "GET", "/api/auth/me");
    assert.equal(res.status, 401);
  });

  await t.test("/api/auth/me returns the logged-in user + their company", async () => {
    const login = await api(base, "POST", "/api/auth/login", {
      body: { email: "priya@testco.io", password: "password123" }
    });
    const res = await api(base, "GET", "/api/auth/me", { token: login.body.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, "priya@testco.io");
    assert.equal(res.body.company.name, "Test Manufacturing");
    assert.equal(res.body.company.region, "IN");
  });

  await stopTestServer();
});
