const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareTestDb } = require("../src/lib/db");
const { startTestServer, stopTestServer, api } = require("./helpers/testServer");

test("rate limiting", async (t) => {
  await prepareTestDb();
  const base = await startTestServer();

  await api(base, "POST", "/api/auth/register-company", {
    body: {
      companyName: "Rate Limit Test Co", sector: "Manufacturing", scale: "SME", region: "IN",
      adminName: "Admin", adminEmail: "admin@ratelimittest.io", adminPassword: "password123"
    }
  });

  await t.test("login is blocked after too many attempts from the same client", async () => {
    let lastStatus;
    // The limiter allows 10 requests per window — send 10 (all with a
    // wrong password, which is realistic brute-force behavior) then a
    // decisive 11th that must be blocked regardless of credentials.
    for (let i = 0; i < 10; i++) {
      const res = await api(base, "POST", "/api/auth/login", {
        body: { email: "admin@ratelimittest.io", password: "wrong-guess" }
      });
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 401, "the first 10 attempts should still reach the real login logic");

    const blockedRes = await api(base, "POST", "/api/auth/login", {
      body: { email: "admin@ratelimittest.io", password: "wrong-guess" }
    });
    assert.equal(blockedRes.status, 429, "the 11th attempt within the window should be rate-limited");
    assert.match(blockedRes.body.error, /too many login attempts/i);
  });

  await t.test("rate limiting does not block a DIFFERENT endpoint", async () => {
    // Confirms the limiter is scoped to /login, not blocking the whole API.
    const res = await api(base, "GET", "/api/health");
    assert.equal(res.status, 200);
  });

  await stopTestServer();
});

test("forgot-password rate limiting", async (t) => {
  await prepareTestDb();
  const base = await startTestServer();

  await t.test("forgot-password is blocked after too many requests", async () => {
    let lastStatus;
    for (let i = 0; i < 5; i++) {
      const res = await api(base, "POST", "/api/auth/forgot-password", {
        body: { email: "anyone@ratelimittest.io" }
      });
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 200);

    const blockedRes = await api(base, "POST", "/api/auth/forgot-password", {
      body: { email: "anyone@ratelimittest.io" }
    });
    assert.equal(blockedRes.status, 429);
    assert.match(blockedRes.body.error, /too many password reset requests/i);
  });

  await stopTestServer();
});
