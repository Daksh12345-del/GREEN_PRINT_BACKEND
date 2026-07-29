const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareTestDb } = require("../src/lib/db");
const { startTestServer, stopTestServer, api } = require("./helpers/testServer");

test("PDF report generation", async (t) => {
  await prepareTestDb();
  const base = await startTestServer();

  const { token } = (await api(base, "POST", "/api/auth/register-company", {
    body: {
      companyName: "Report Test Co", sector: "Manufacturing", scale: "SME", region: "IN",
      adminName: "Admin", adminEmail: "admin@reporttest.io", adminPassword: "password123"
    }
  })).body;

  await api(base, "POST", "/api/logs", { token, body: { activityType: "electricity", quantity: 1200, renewableShare: 30 } });
  await api(base, "POST", "/api/logs", { token, body: { activityType: "diesel", quantity: 80, renewableShare: 0 } });

  await t.test("returns a real PDF file, not JSON or an error page", async () => {
    const res = await fetch(`${base}/api/reports/esg.pdf`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");

    const buffer = Buffer.from(await res.arrayBuffer());
    // A real multi-page PDF with cover/summary/table/methodology content
    // is comfortably several KB — this would be tiny if generation broke
    // and returned an empty/near-empty document.
    assert.ok(buffer.length > 3000, `expected a substantial PDF, got ${buffer.length} bytes`);
    // Every valid PDF starts with this exact magic header.
    assert.equal(buffer.subarray(0, 5).toString("ascii"), "%PDF-");
  });

  await t.test("requires authentication", async () => {
    const res = await fetch(`${base}/api/reports/esg.pdf`);
    assert.equal(res.status, 401);
  });

  await stopTestServer();
});
