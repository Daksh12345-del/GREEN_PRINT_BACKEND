// helpers/testServer.js
// Starts the REAL Express app (server.js) on an OS-assigned random port —
// no mocking, no stubbing. Every test in this suite talks to the actual
// route handlers, actual auth middleware, and a real Postgres database.

const http = require("http");

let server = null;

async function startTestServer() {
  const { app } = require("../../server");
  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function stopTestServer() {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  server = null;
}

// Small convenience wrapper around fetch — returns { status, body }.
async function api(baseUrl, method, path, { token, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const contentType = res.headers.get("content-type") || "";
  const parsed = contentType.includes("application/json") ? await res.json().catch(() => null) : null;
  return { status: res.status, body: parsed, raw: res };
}

module.exports = { startTestServer, stopTestServer, api };
