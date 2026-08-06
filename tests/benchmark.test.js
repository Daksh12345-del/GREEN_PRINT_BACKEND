const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareTestDb, query } = require("../src/lib/db");
const { startTestServer, stopTestServer, api } = require("./helpers/testServer");

async function registerCo(base, { name, email, sector = "Manufacturing", region = "IN" }) {
  const res = await api(base, "POST", "/api/auth/register-company", {
    body: {
      companyName: name, sector, scale: "SME", region,
      adminName: "Admin", adminEmail: email, adminPassword: "password123"
    }
  });
  const me = await api(base, "GET", "/api/auth/me", { token: res.body.token });
  return { token: res.body.token, companyId: me.body.company.id };
}

async function logElectricity(companyId, quantity, renewableShare, co2eOverride) {
  // Insert directly with a controlled co2e_kg so test math is exact and
  // independent of the seeded emission factor values.
  await query(
    `INSERT INTO logs (company_id, activity_type, quantity, unit, renewable_share, source, co2e_kg)
     VALUES ($1,'electricity',$2,'kWh',$3,'manual',$4)`,
    [companyId, quantity, renewableShare, co2eOverride]
  );
}

test("sector benchmark", async (t) => {
  await prepareTestDb();
  const base = await startTestServer();

  await t.test("not enough peers yet returns available: false, never leaks a raw average", async () => {
    const solo = await registerCo(base, { name: "Lonely Co", email: "lonely@bench.io", sector: "Hospitality" });
    await logElectricity(solo.companyId, 100, 10, 50);

    const res = await api(base, "GET", "/api/kpis/benchmark", { token: solo.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.available, false);
    assert.equal(res.body.sector, "Hospitality");
    assert.equal(res.body.peerCount, 0);
    assert.equal(res.body.minPeersRequired, 3);
    assert.equal(res.body.yourCompany, undefined, "must not include comparison data when unavailable");
    assert.equal(res.body.sectorAverage, undefined, "must not leak an average from too few peers");
  });

  await t.test("with 3+ peers, returns an anonymized average and a correct percentile", async () => {
    // 4 companies in "Construction": peers at green-score-relevant renewable
    // shares of 0%, 20%, 40%, and "you" at 60% — so you should beat everyone.
    const peerA = await registerCo(base, { name: "Peer A", email: "peera@bench.io", sector: "Construction" });
    const peerB = await registerCo(base, { name: "Peer B", email: "peerb@bench.io", sector: "Construction" });
    const peerC = await registerCo(base, { name: "Peer C", email: "peerc@bench.io", sector: "Construction" });
    const you = await registerCo(base, { name: "You Co", email: "you@bench.io", sector: "Construction" });

    // Same quantity/co2e for every company so only renewable_share differs
    // -> isolates the effect on Green Score cleanly.
    await logElectricity(peerA.companyId, 1000, 0, 500);
    await logElectricity(peerB.companyId, 1000, 20, 500);
    await logElectricity(peerC.companyId, 1000, 40, 500);
    await logElectricity(you.companyId, 1000, 60, 500);

    const res = await api(base, "GET", "/api/kpis/benchmark", { token: you.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.available, true);
    assert.equal(res.body.sector, "Construction");
    assert.equal(res.body.peerCount, 3);

    assert.equal(res.body.yourCompany.renewableShare, 60);
    // Sector average renewable share across the 3 peers: (0+20+40)/3 = 20
    assert.equal(res.body.sectorAverage.renewableShare, 20);

    // Your Green Score is strictly the highest (most renewable, same total
    // emissions) -> percentile should be 100.
    assert.equal(res.body.percentile, 100, "beating every peer should give the 100th percentile");

    // Never exposes individual peer companies by name or id.
    const raw = JSON.stringify(res.body);
    assert.ok(!raw.includes("Peer A") && !raw.includes("Peer B") && !raw.includes("Peer C"),
      "benchmark response must never include peer company names");
  });

  await t.test("a below-average company gets a low percentile, not a negative or misleading one", async () => {
    const laggard = await registerCo(base, { name: "Laggard Co", email: "laggard@bench.io", sector: "Construction" });
    // 0% renewable, same volume/emissions as the others -> worst Green Score in the sector.
    await logElectricity(laggard.companyId, 1000, 0, 500);

    const res = await api(base, "GET", "/api/kpis/benchmark", { token: laggard.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.available, true);
    assert.ok(res.body.percentile >= 0 && res.body.percentile <= 100);
    assert.ok(res.body.percentile < 100, "the worst-performing company should not read as the 100th percentile");
  });

  await t.test("requires companyId for super_admin, same as other kpi endpoints", async () => {
    await query(
      `INSERT INTO users (name, email, password_hash, role, company_id)
       VALUES ('Super', 'super@bench.io', $1, 'super_admin', NULL)`,
      [require("bcryptjs").hashSync("password123", 10)]
    );
    const login = await api(base, "POST", "/api/auth/login", { body: { email: "super@bench.io", password: "password123" } });
    const res = await api(base, "GET", "/api/kpis/benchmark", { token: login.body.token });
    assert.equal(res.status, 400);
  });

  await stopTestServer();
});
