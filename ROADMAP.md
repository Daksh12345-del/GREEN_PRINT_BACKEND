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

## What's next, in priority order

### Phase 1 — Strengthen what exists
- **Historical factor versioning.** Right now emissions are computed
  against the *current* factor table on every read. If a government
  updates a factor next year, this year's report would silently change.
  Fix: snapshot the factor used at log-entry time (the API already returns
  `factorsUsed` per log — persisting that alongside the log is the next
  step).
- **More regions.** Only 6 regions + GLOBAL are seeded. Adding more (Japan,
  Australia, Brazil, etc.) is just data entry via the Emission Factors
  page — no code change needed, but someone needs to research and cite
  the numbers.
- **Site-specific NOx/SOx overrides per facility**, since these genuinely
  vary by equipment — right now they're one indicative number per
  region/fuel, not per facility.

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
