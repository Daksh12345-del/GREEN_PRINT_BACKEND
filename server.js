// server.js
// Green Print API — Express app wiring together auth, companies, facilities,
// vehicles, users, logs, KPIs, and the AI Recommendation Engine.
// All data lives in your real Supabase Postgres project via
// src/lib/db.js — nothing here is in-memory or mock.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const db = require("./src/lib/db");
const authRoutes = require("./src/routes/auth");
const companiesRoutes = require("./src/routes/companies");
const facilitiesRoutes = require("./src/routes/facilities");
const vehiclesRoutes = require("./src/routes/vehicles");
const usersRoutes = require("./src/routes/users");
const logsRoutes = require("./src/routes/logs");
const kpisRoutes = require("./src/routes/kpis");
const aiRoutes = require("./src/routes/ai");
const emissionFactorsRoutes = require("./src/routes/emissionFactors");
const devicesRoutes = require("./src/routes/devices");
const ingestRoutes = require("./src/routes/ingest");
const carbonCreditsRoutes = require("./src/routes/carbonCredits");
const reportsRoutes = require("./src/routes/reports");

const app = express();
const PORT = process.env.PORT || 3000;

// In production (Render), set ALLOWED_ORIGIN to your Vercel frontend's URL
// (e.g. https://greenprint.vercel.app) so only that origin can call this
// API. Left unset, this defaults to "*" (any origin) — fine for local dev
// and testing, but tighten it before this is handling real user data.
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());

// Serves the built frontend if it exists in this same deployment — only
// relevant when running server + client together locally in one process.
// On Render (split deployment), client/dist won't exist here at all since
// the frontend is built and hosted separately on Vercel; these two lines
// then simply do nothing, harmlessly.
const clientDist = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientDist));

app.use("/api/auth", authRoutes);
app.use("/api/companies", companiesRoutes);
app.use("/api/facilities", facilitiesRoutes);
app.use("/api/vehicles", vehiclesRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/logs", logsRoutes);
app.use("/api/kpis", kpisRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/emission-factors", emissionFactorsRoutes);
app.use("/api/devices", devicesRoutes);
app.use("/api/ingest", ingestRoutes);
app.use("/api/carbon-credits", carbonCreditsRoutes);
app.use("/api/reports", reportsRoutes);

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    database: "supabase-postgres",
    aiMode: process.env.GROQ_API_KEY ? "groq" : "rule-based fallback"
  });
});

// SPA fallback (production only, after `npm run build` in /client)
app.get("*", (req, res) => {
  res.sendFile(path.join(clientDist, "index.html"), (err) => {
    if (err) {
      res
        .status(404)
        .send("Frontend not built yet. Run `npm run build` in /client, or run the client dev server separately.");
    }
  });
});

async function start() {
  console.log("Connecting to Supabase Postgres and running schema migration…");
  await db.init();

  app.listen(PORT, () => {
    console.log(`Green Print server running on http://localhost:${PORT}`);
    console.log(
      `AI mode: ${process.env.GROQ_API_KEY ? "Groq API (live)" : "rule-based fallback (set GROQ_API_KEY to enable live AI)"}`
    );
  });
}

start().catch((err) => {
  console.error("Failed to start Green Print server:", err.message);
  process.exit(1);
});
