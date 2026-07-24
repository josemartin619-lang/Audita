# Audita — audit-first accounting for Saudi Arabia

A double-entry accounting engine where **the audit layer is the product**: every
entry lands in a tamper-evident, hash-chained ledger, continuous controls flag
anomalies as you post, and any figure traces back to its evidence. Built for the
Saudi market — IFRS chart of accounts, 15% VAT, SAR, ZATCA e-invoicing (the
Previous-Invoice-Hash chain is the same mechanism as the audit trail). Fully
**bilingual English / العربية** with right-to-left layout.

## Try it — demo logins

Password for all: `audita`

| Email | Role |
|---|---|
| `ana@audita.co` | Partner (full access) |
| `carlos@audita.co` | Accountant |
| `sofia@audita.co` | Staff |

The app seeds a demo firm with three Saudi clients (one high-risk with planted
anomalies the control engine catches, one clean, one medium) so there's real
data to explore immediately.

## Run it locally

Requires Node 20+.

```bash
npm install
npm run api        # http://localhost:3000
```

That's it — no database needed (runs against an in-memory ledger). To run the
test suite: `npm test` (71 tests: property-based invariants, API, tenancy).

## Deploy a live link (free)

The repo ships a Render blueprint. In [Render](https://render.com):
**New → Blueprint → connect this repo**. Render reads `render.yaml`, builds the
Dockerfile, generates a secure secret, and gives you a public HTTPS URL — no
manual setup. Free tier sleeps when idle and wakes on the next visit.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

> After creating your GitHub repo, you can also point the button directly at it:
> `https://render.com/deploy?repo=https://github.com/<your-username>/audita`

## What's inside

Double-entry ledger (money as integer minor units, never floats) · SHA-256
hash-chained audit trail · continuous control rules + risk scoring · working
papers & evidence-ready close · "prove this number" provenance ·
cryptographically-verifiable sharing · AR/AP subledger & aging · cash-flow
statement · IFRS financial-statement PDF · ZATCA e-invoicing (UUID / ICV / PIH
chain / TLV QR — simulated; live clearance needs ZATCA onboarding).

Built with TypeScript, Express, and a storage-agnostic core (in-memory by
default; a trigger-enforced Postgres layer is included).
