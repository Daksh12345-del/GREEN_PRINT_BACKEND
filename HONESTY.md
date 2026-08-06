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

**Historical factor versioning.** Every log's emissions are computed once,
at write time, against that day's emission factors, and permanently
stored on the row (`co2e_kg`/`nox_kg`/`sox_kg`/`factors_snapshot`). Every
read afterwards (dashboard, AI insights, PDF, CSV) uses that stored value
— never a fresh recomputation. Verified directly: logged an activity,
changed the underlying factor to a wildly different number, confirmed the
original log's number didn't move, and confirmed a brand-new log picked
up the changed factor. Pre-existing logs from before this feature shipped
are backfilled once, automatically, on server startup, using the best
available (current) factors — documented as a stated tradeoff since there's
no record of what factor was truly in effect when they were first logged.

**CSV / Excel export.** `GET /api/reports/logs.csv` streams every logged
activity with its stored (historically accurate) emissions — verified to
be valid, parseable CSV that opens correctly, with the same numbers as
the PDF report (both read from the same stored snapshot).

**Month-over-month alerts.** `GET /api/kpis/trend` compares this
calendar month's CO2e to last month's using each log's real timestamp,
and the Dashboard shows a banner when the increase crosses 20%. Verified
by inserting logs at controlled past/present timestamps and confirming
the exact percentage and alert flag. This is **in-app only** right now —
turning it into an actual email requires a scheduler (see `ROADMAP.md`
for the concrete path using a GitHub Actions cron, same pattern as the
smoke test).

**Dark mode.** A real toggle, not just a CSS filter — separate token
values for every color variable the app uses, switched via a
`data-theme` attribute, persisted in `localStorage`, and defaults to the
visitor's OS-level preference on first visit.

**Hindi/English toggle — partial, honestly scoped.** Login, signup, the
full navigation sidebar, and the Dashboard's labels are genuinely
bilingual. Other pages (Facilities, Fleet, Team, Emission Factors, etc.)
are still English-only — see `ROADMAP.md`'s "Multi-language coverage"
section for exactly what's covered and how to extend it. A missing
translation key silently falls back to English rather than breaking the
page.

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

**Interactive charts.** `GET /api/kpis/timeseries` (monthly/yearly,
Scope 1 vs Scope 2) and `GET /api/kpis/by-facility` (per-facility CO2e
share) are both built from each log's stored emissions snapshot — never
a fresh recomputation, same rule as everywhere else. Verified end-to-end:
logged real activity against a live server, confirmed the returned
numbers match `quantity × emission factor` exactly, and confirmed the
facility grouping (including the "Unassigned / Fleet" bucket for logs
with no facility) sums to the same total as the KPI endpoint. 9 new
automated tests, all passing against a real Postgres database.

**Sector benchmarking.** `GET /api/kpis/benchmark` compares your Green
Score, renewable share, and average CO2e/log against other companies in
your sector — anonymized: it refuses to return an average (`available:
false`) until at least 3 *other* companies in your sector have logged
activity, so the "average" can never be reverse-engineered into one or
two competitors' real numbers. Individual peer companies are never named
or identified anywhere in the response — verified by a test that greps
the raw JSON for peer company names. Deliberately benchmarks on
size-independent metrics (Green Score, renewable %), not raw total CO2e,
since this app doesn't collect production volume/revenue to normalize a
tonnage comparison fairly across company sizes — a documented tradeoff,
not an oversight. 5 new automated tests, all passing, plus a live curl
run confirming the exact "2 peers = locked, 3 peers = unlocked" behavior.

**Onboarding wizard.** A Dashboard checklist (facility/vehicle → first
log → explore insights) computed entirely from real data — whether a
step shows as done is read from actual facilities/vehicles/logs that
exist, never from a separate "onboarding complete" flag that could drift
out of sync with reality. Auto-hides once every applicable step is done,
or if dismissed (remembered per-user in `localStorage`, same pattern as
dark mode/language). Role-aware: a fleet_manager is guided to add a
vehicle, a company_admin/plant_manager to add a facility, and a role with
neither permission (employee, auditor) skips straight to logging an
activity, since `facilityId`/`vehicleId` are optional on a log.

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
values (diesel, coal, and now natural gas — EPA AP-42, cross-validated
against a second independent source) are published indicative averages,
clearly labeled as such — real regulatory filings normally use
site-specific stack-test results instead. **Deliberately not seeded**:
petrol/LPG vehicle NOx & SOx (published figures vary up to 150x by
vehicle age/Euro emissions standard — a single average would be actively
misleading, not just imprecise) and grid electricity NOx/SOx (standard
GHG accounting frameworks track these at the power-plant/national level,
not per kWh consumed — inventing a per-kWh figure wouldn't match how any
real framework reports it). See `src/lib/db.js`'s seed comments for the
full reasoning on each.

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
