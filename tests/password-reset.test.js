const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { prepareTestDb, query } = require("../src/lib/db");
const { startTestServer, stopTestServer, api } = require("./helpers/testServer");

test("password reset flow", async (t) => {
  await prepareTestDb();
  const base = await startTestServer();

  await api(base, "POST", "/api/auth/register-company", {
    body: {
      companyName: "Reset Test Co", sector: "Manufacturing", scale: "SME", region: "IN",
      adminName: "Admin", adminEmail: "admin@resettest.io", adminPassword: "originalpass123"
    }
  });

  await t.test("forgot-password gives the same generic response for a real email", async () => {
    const res = await api(base, "POST", "/api/auth/forgot-password", {
      body: { email: "admin@resettest.io" }
    });
    assert.equal(res.status, 200);
    assert.match(res.body.message, /if that email has an account/i);
  });

  await t.test("forgot-password gives the SAME response for a made-up email (no leak)", async () => {
    const res = await api(base, "POST", "/api/auth/forgot-password", {
      body: { email: "nobody-real@resettest.io" }
    });
    assert.equal(res.status, 200);
    assert.match(res.body.message, /if that email has an account/i);
  });

  await t.test("reset-password with a bogus token is rejected", async () => {
    const res = await api(base, "POST", "/api/auth/reset-password", {
      body: { token: "totally-made-up-token", newPassword: "newpassword123" }
    });
    assert.equal(res.status, 400);
  });

  await t.test("a real reset token successfully changes the password, and can then log in with it", async () => {
    // Insert a reset row directly (mirrors what forgot-password does) so
    // the test knows the raw token to use.
    const userRes = await query("SELECT id FROM users WHERE email = $1", ["admin@resettest.io"]);
    const userId = userRes.rows[0].id;

    const rawToken = "test-raw-token-12345";
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await query(
      "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,$3)",
      [userId, tokenHash, expiresAt]
    );

    const resetRes = await api(base, "POST", "/api/auth/reset-password", {
      body: { token: rawToken, newPassword: "brandnewpassword123" }
    });
    assert.equal(resetRes.status, 200);

    const loginOld = await api(base, "POST", "/api/auth/login", {
      body: { email: "admin@resettest.io", password: "originalpass123" }
    });
    assert.equal(loginOld.status, 401, "old password should no longer work");

    const loginNew = await api(base, "POST", "/api/auth/login", {
      body: { email: "admin@resettest.io", password: "brandnewpassword123" }
    });
    assert.equal(loginNew.status, 200, "new password should work");
  });

  await t.test("a used token cannot be reused", async () => {
    const userRes = await query("SELECT id FROM users WHERE email = $1", ["admin@resettest.io"]);
    const userId = userRes.rows[0].id;

    const rawToken = "already-used-token-67890";
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    await query(
      "INSERT INTO password_resets (user_id, token_hash, expires_at, used_at) VALUES ($1,$2,$3, now())",
      [userId, tokenHash, new Date(Date.now() + 15 * 60 * 1000)]
    );

    const res = await api(base, "POST", "/api/auth/reset-password", {
      body: { token: rawToken, newPassword: "anotherpassword123" }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /already been used/i);
  });

  await t.test("an expired token is rejected", async () => {
    const userRes = await query("SELECT id FROM users WHERE email = $1", ["admin@resettest.io"]);
    const userId = userRes.rows[0].id;

    const rawToken = "expired-token-abcde";
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const pastExpiry = new Date(Date.now() - 60 * 1000); // 1 minute ago
    await query(
      "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,$3)",
      [userId, tokenHash, pastExpiry]
    );

    const res = await api(base, "POST", "/api/auth/reset-password", {
      body: { token: rawToken, newPassword: "somepassword123" }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /expired/i);
  });

  await stopTestServer();
});
