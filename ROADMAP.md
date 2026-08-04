# Green Print — Product Roadmap

_Last updated: July 2026_

See `HONESTY.md` for the detailed real-vs-estimate breakdown. This file
tracks what's built vs. what's next.

## Where things stand today

| Area | Status |
|---|---|
| Carbon Accounting Engine | ✅ Multi-pollutant (CO2e, NOx, SOx), configurable per-region factors, fully sourced |
| Database | ✅ Real, cloud-hosted Supabase Postgres |
| Auth | ✅ JWT + bcrypt, 6 roles, company-scoped |
| Multi-company management | ✅ super_admin cross-company dashboard |
| Emission factors | ✅ Configurable via DB (`emission_factors` table) — CEA/DEFRA/EPA sourced, editable without a code change |
| Region-aware companies | ✅ Each company picks a region; factors resolve to it, falling back to GLOBAL |
| IoT / real-time data ingestion | ✅ API-key authenticated `/api/ingest/logs` endpoint — no human required |
| PDF ESG reports | ✅ Real downloadable PDF, GHG Protocol Scope 1/2 structured, with cited methodology |
| Carbon Credit Estimator | ✅ Configurable baseline + price, clearly labeled as an estimate (not an issued credit) |
| AI Recommendation Engine | ✅ Live via Groq API, transparent rule-based fallback |
| Team management | ✅ Role-based invites |
| Self-serve signup | ✅ With region selection |
| Password reset | ✅ Real email via Resend, 15-min single-use tokens |
| Rate limiting | ✅ Login/signup/forgot-password brute-force & spam protection |
| Production smoke tests | ✅ Automated, runs every 30 min against the real deployed URL |
| Historical factor versioning | ✅ Emissions snapshotted permanently at write time — updating a factor never changes past logs |
| Natural gas NOx | ✅ Real EPA AP-42 factor added, cross-validated against a second source |
| CSV export | ✅ Every log + its historically-accurate emissions, opens directly in Excel/Sheets |
| Month-over-month alerts | ✅ In-app banner when this month's CO2e is 20%+ above last month's |
| Dark mode | ✅ Full theme toggle, persisted, respects system preference on first visit |
| Hindi/English toggle | ✅ Login, signup, navigation, and dashboard fully bilingual — see "Multi-language coverage" below |

## Multi-language coverage (honest scope)

The Hindi/English toggle (client/src/translations.js) currently covers:
login, registration, the entire nav sidebar, and the Dashboard page's
labels. It does **not** yet cover every string on every page (Facilities,
Fleet, Team, Emission Factors, etc. are still English-only). This is a
deliberate scope choice — the highest-traffic screens are fully bilingual,
and any translation key missing from a language silently falls back to
English (see `LanguageContext.jsx`'s `t()` function) rather than breaking,
so extending coverage to more pages is a safe, incremental task: add more
keys to `translations.js` and swap in `t("key")` calls page by page.

## What's next, in priority order

### Phase 1 — Strengthen what exists
- **More regions.** Only 6 regions + GLOBAL are seeded. Adding more (Japan,
  Australia, Brazil, etc.) is just data entry via the Emission Factors
  page — no code change needed, but someone needs to research and cite
  the numbers.
- **Site-specific NOx/SOx overrides per facility**, since these genuinely
  vary by equipment — right now they're one indicative number per
  region/fuel, not per facility.
- **Petrol/LPG vehicle NOx & SOx** — deliberately left unseeded (see
  `HONESTY.md`) because published figures vary up to 150x by vehicle
  age/Euro standard; a real fleet would need to state its own assumption
  or plug in telematics-based per-vehicle data instead of one average.
- **Email alerts, not just in-app.** `GET /api/kpis/trend` already
  computes the month-over-month comparison and flags when it crosses the
  alert threshold — the Dashboard shows it as a banner. Turning that into
  an actual email requires a scheduler (there's no cron inside the Node
  app itself); the cleanest option is a GitHub Actions workflow on a
  monthly `schedule:` trigger — same pattern as `smoke-test.yml` — that
  calls the trend endpoint for each company and emails via Resend
  (`src/lib/email.js` already has the sending logic) when `isAlert` is true.

### Phase 2 — Deeper integrations
- **Provider-specific IoT connectors.** The generic `/api/ingest/logs`
  endpoint works with any device today. Purpose-built connectors for
  specific smart meter brands, fleet telematics providers (Samsara,
  Motive), or utility company APIs would remove even the "configure a
  device" step.
- **Water footprint tracking.** Mentioned in the original vision, not yet
  modeled — would need its own factor type and log activity types (e.g.
  water withdrawal, wastewater).

### Phase 3 — Compliance depth
- **Automated regulatory filing** — actually submitting to government
  portals (Pollution Control Boards, Smart City systems), vs. just
  generating a PDF a human then submits.
- **Audit trail / change history** on logs (who edited what, when) — for
  when an actual third-party auditor reviews the data.

### Phase 4 — AI depth
- **Emission forecasting** (next month/quarter) from historical logs.
- **Anomaly detection** — flag a log that's a statistical outlier vs. a
  facility's own history (possible fat-finger entry or a real leak).
- **AI chatbot** over a company's own data, extending the existing AI
  Insights module.

### Ongoing, cross-cutting
- **Automated test suite** — still none. Add before any real customer data
  touches this.
- **Deployment** — single Node process today; fine for a pilot, will need
  a real host (Render/Vercel/AWS) once there's real traffic. Supabase
  already handles the database side of scaling.
- **Billing** — no Stripe/payment integration yet for the SaaS model.

## What can never be "built" — only earned

No software update makes these true; they require a human/institutional
process outside this codebase:
- **ISO 14001 / GHG Protocol / BRSR / CDP certification** — requires an
  accredited third-party auditor.
- **Issued carbon credits** — requires a registry (Verra, Gold Standard)
  to verify and issue them; this software can only estimate.

This isn't a roadmap gap to "close" — it's a permanent, correct boundary
between what software can do and what only a human auditor/registry can.
