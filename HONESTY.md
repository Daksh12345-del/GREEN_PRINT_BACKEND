# What's real, what's an estimate — read this before you present Green Print

This file exists so nobody — including you — accidentally overstates what
this software does. Every claim below is checked against the actual code.

## ✅ Fully real, verified working

**Authentication.** Passwords are hashed with bcrypt before storage. Login
issues a real JWT. There is no fake/bypassable check anywhere.

**Database.** Your Supabase project holds real Postgres tables. Data
persists across restarts — nothing is in-memory or reset on refresh.

**Roles & multi-tenancy.** Company admin, plant manager, fleet manager,
etc. have genuinely different access. One company's data is never visible
to another (except super_admin, by design).

**Emission calculations.** Every CO2e/NOx/SOx number is
`activity quantity × a sourced emission factor`, computed from real data
you logged. There is no `Math.random()`, no placeholder numbers, anywhere
in this codebase.

**Configurable factors, not hardcoded.** All conversion factors live in
the `emission_factors` Postgres table, seeded from:
- **India electricity**: Central Electricity Authority, CO2 Baseline
  Database v21.0 (Dec 2025) — 0.710 kg CO2e/kWh, national weighted average
- **UK electricity & all fuel combustion (diesel, petrol, natural gas,
  LPG, coal)**: UK DEFRA/DESNZ Government GHG Conversion Factors for
  Company Reporting, 2026
- **Germany/France/Singapore electricity**: Ember 2025 estimates
- **NOx/SOx for diesel and coal**: US EPA AP-42 indicative averages

A super_admin can add new regions or edit any factor from the Emission
Factors page — no code change required.

**Automated production smoke test.** `.github/workflows/smoke-test.yml`
actually hits the real deployed URL every 30 minutes — not a mock, not a
localhost check. Verified both directions: ran it against a real running
server (all checks pass) and against a stopped one (correctly fails with
exit code 1, so CI would show it red). GitHub emails you automatically if
a scheduled run fails.

**Rate limiting.** Login, registration, and forgot-password are all
protected against brute-force/spam — 10 login attempts per 15 minutes,
10 signups per hour, 5 password-reset requests per 15 minutes, all
tracked per IP address. Verified by actually exhausting each limit in
the test suite and confirming the exact request that should be blocked
gets a 429, and that a different, unrelated endpoint is never affected.

**Password reset.** `POST /api/auth/forgot-password` + `/reset-password` is
a real, working flow — a random token is generated, hashed with SHA-256
before storage (never the raw token), expires after 15 minutes, and can
only be used once. The endpoint gives the exact same response whether or
not the email exists, so it can't be used to check who has an account.
Sends real email via Resend when `RESEND_API_KEY` is set; without it, the
reset link is printed to the server console instead — verified end-to-end
(request → console link → reset → login with the new password all work).

**IoT ingestion.** `POST /api/ingest/logs`, authenticated by a real API
key (SHA-256 hashed, never stored in plaintext), is a genuine endpoint a
real sensor or telematics device could call today. Verified: created a
device, pushed a reading with only the API key (no user login), server
computed correct emissions from it. A request with a wrong key is
correctly rejected with 401.

**PDF reports.** `GET /api/reports/esg.pdf` generates an actual PDF file
(via `pdfkit`), not a mockup — Scope 1/2 breakdown, full activity log, and
a methodology page listing every factor and its source. Verified by
generating and visually inspecting a real report.

## ⚠️ Real math, but simplified / not certified

**"Formatted to align with GHG Protocol Scope 1/2."** The report groups
fuel combustion as Scope 1 and purchased electricity as Scope 2, which is
the correct GHG Protocol categorization. But **this is not a certified GHG
Protocol statement** — that requires an accredited third party to verify
your data and methodology. The report says this explicitly, in red, on
page one.

**"ISO 14001 / BRSR / CDP aligned."** Same caveat. The report's structure
can support these frameworks' typical data requirements, but **certification
itself only comes from an accredited auditor**, not from any software.

**NOx/SOx factors.** Unlike CO2e (which is fairly consistent for a given
fuel), NOx and SOx vary a lot by engine/boiler technology. The seeded
values are published indicative averages (EPA AP-42), clearly labeled as
such — real regulatory filings normally use site-specific stack-test
results instead.

**Green Score / ESG score.** A documented, transparent formula (see
`server/src/lib/emissions.js`) that rewards renewable share and penalizes
total CO2e. It is **not** an official/certified ESG rating from any
standards body — it's this app's own illustrative scoring.

## ❌ Explicitly an estimate, never claimed as certified

**Carbon Credit Estimator.** Computes `(baseline − current emissions) ×
price per tonne`. This is a **planning estimate only**. Real, tradeable
carbon credits can only be issued by a recognized registry (Verra, Gold
Standard, etc.) after independent verification of your baseline and
reductions — this software cannot and does not issue credits. Every
screen and API response for this feature says so directly.

## Still not built at all (see ROADMAP.md for the plan)

- Independent/third-party audit workflow (inherently can't be "built" —
  it requires an actual accredited auditor)
- Direct integrations with specific utility company APIs or telematics
  providers (the generic IoT ingestion endpoint works with any device that
  can make an HTTP POST; provider-specific connectors are a roadmap item)
- Automated regulatory filing/submission to government portals

## The one-sentence version

**Every number is real and traceable to a cited source. No certification
claimed anywhere is actually certified — that always requires a human
auditor, which this software is honest about not being.**
