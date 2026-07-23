# Audita — audit-first accounting core (v0.2)

> **v0.2 adds:** a REST API (Express) with API-key auth + tenant scoping, a
> multi-client **firm workspace** with structural per-client isolation, a live
> **API-backed console UI** (`public/`), a **real DIAN HTTP provider adapter**
> (`HttpPTProvider`), deeper controls (related-party, population Benford,
> velocity), a **DIAN tax-position report**, a verified **Postgres** layer
> (immutability enforced by DB triggers), and CI. 45 tests, all green.
>
> **Interface:** the console UI is **bilingual (EN / ES)** with a switch at the
> top right, and is **self-contained** — fonts are served locally from
> `public/fonts` (no external CDN), so it works offline. Art direction is a
> deliberate editorial/surreal treatment (warm desert palette, Playfair Display
> + Spectral, hairline rules, long cast shadows) rather than a stock template;
> the data tables stay crisp for daily use.
>
> ```bash
> npm install && npm test        # 45 tests incl. property + API + tenancy
> npm run api                    # http://localhost:3000  (UI + JSON API)
> npm run demo                   # single-client console demo
> # Postgres (optional): load schema.sql, then
> DATABASE_URL=postgres://audita@localhost:5432/audita npm run test:pg
> ```
>
> API is key-protected: send `x-api-key: dev-key` (set `AUDITA_API_KEY`). The UI
> is served at `/`; endpoints live under `/api/clients/...`.

---

## Audita — audit-first accounting core (Phase 0 foundation)

A double-entry accounting engine for the Colombian market where the **audit
layer is the product, not an afterthought**. This is the Phase 0 foundation
from the plan: the ledger core, the immutable audit trail, continuous controls,
working papers, risk scoring, financial reports, and the DIAN e-invoicing seam —
all real, all tested.

It is deliberately **not** a full app (no UI, no payroll, no inventory). It is
the fortress the rest of the product gets built on. See `../plan-audit-first-accounting.md`.

## Why this exists / the one rule

Accounting software is a **trust product**. A rounding bug or a silently edited
entry isn't a glitch — it misstates taxes and ends the company's credibility.
So the money path is a fortress with these non-negotiables, all enforced in code
and covered by tests:

1. **Money is never a float.** Stored as `bigint` centavos (`src/domain/money.ts`).
2. **Double-entry, always.** An entry that doesn't balance cannot be built
   (`normalizeLines` throws before anything persists).
3. **Append-only.** Posted entries are immutable; corrections are reversing
   entries. Enforced in the repo and, in Postgres, by DB triggers.
4. **The trial balance always sums to zero.** A 200-run property test proves it
   holds after any sequence of postings.
5. **Every event is in a hash-chained audit trail.** Tampering breaks the chain
   and is detectable without trusting the operator.

## Run it

```bash
npm install
npm test          # 30 tests incl. the property-based invariants
npm run typecheck # strict TS, no errors
npm run demo      # seeds a month, prints reports + findings + risk + close
```

No database is needed — tests and the demo run against the in-memory repository.

## Architecture

The core is **storage-agnostic** and **DIAN-agnostic** via two seams, so the
domain never depends on infrastructure:

```
src/
  domain/                 # pure logic, no I/O
    money.ts              # bigint centavos, exact rate math, COP formatting
    accounts.ts           # PUC chart of accounts
    journal.ts            # entries, lines, double-entry validation, reversal
    ledger? (service)     # (posting engine lives in services/)
    auditTrail.ts         # SHA-256 hash-chained immutable log + verify()
    findings.ts           # finding model + severity weights
    controls/rules.ts     # 6 per-entry rules + invoice sequence-gap rule
    reports.ts            # trial balance, P&L, balance sheet
    workingPapers.ts      # native tie-outs + evidence-ready close package
    riskScoring.ts        # 0..100 explainable client risk score
  einvoicing/
    provider.ts           # EInvoicingProvider interface (the DIAN seam)
    sandboxProvider.ts    # local adapter; REAL CUFE (SHA-384) formula
    types.ts
  persistence/
    repository.ts         # Repository interface (the storage seam)
    memoryRepo.ts         # in-memory impl (tests + demo)
    pg/schema.sql         # Postgres DDL — append-only enforced by triggers
    pg/pgRepo.ts          # Postgres impl of Repository
  services/
    ledgerService.ts      # THE posting engine — balance, audit, controls
    invoiceService.ts     # issue e-invoice + book the sale, atomically
  index.ts                # demo
```

The dependency rule: `domain` depends on nothing; `services` orchestrate
`domain` + a `Repository` + an `EInvoicingProvider`; infrastructure
(`persistence/pg`, real providers) implements the interfaces. Swap Postgres for
the in-memory repo, or the sandbox provider for a certified one, and the domain
does not change a line.

## The audit layer (the wedge)

- **Immutable evidence chain** (`auditTrail.ts`) — every post, reversal,
  invoice, and finding-status change is hash-linked. `verify()` catches any
  retroactive edit, reorder, or deletion.
- **Continuous controls** (`controls/rules.ts`) — run at post time, not
  month-end: weekend postings, large round numbers, amounts just under an
  approval threshold (fraccionamiento), duplicates, Benford leading-digit,
  manual cash adjustments, and invoice consecutive gaps. Each is a pure,
  explainable function — an auditor can see exactly why something flagged.
- **Findings workflow** — open / reviewed / cleared / escalated, every change
  logged to the trail.
- **Working papers** (`workingPapers.ts`) — tie booked balances to external
  support; the **close package** refuses to close while the books don't
  balance, the trail is broken, a high finding is open, or a paper doesn't tie.
- **Risk scoring** (`riskScoring.ts`) — a bounded, explainable 0..100 score so a
  firm sees which clients need attention this month.

## DIAN electronic invoicing — the honest status

`SandboxEInvoicingProvider` computes the **CUFE with DIAN's real SHA-384 field
formula** (see `sandboxProvider.ts`) but makes **no live DIAN call** and uses a
placeholder ClaveTecnica. That is intentional and it is the correct MVP posture:

> You integrate a **certified Proveedor Tecnológico (PT)**; you do **not** build
> DIAN certification yourself. Becoming a PT is a multi-month regulatory project
> and it is not your product.

To go live: implement `EInvoicingProvider` with an adapter that calls your PT's
API, put its credentials in `.env` (see `.env.example`), and register it where
the sandbox provider is constructed. Nothing else changes.

## What's deliberately NOT here (and why)

Payroll (nómina electrónica), inventory/POS, multi-currency, a UI, live bank
feeds, and becoming your own DIAN PT. Each is a scope trap that would dilute the
wedge. Phase 0 is the correct, tested core — everything else earns its way in
later. The clickable UI prototype (`audita-prototype.html`) shows the same ideas
for demoing to accountants.

## Postgres (when you want it)

```bash
createdb audita
psql audita -f src/persistence/pg/schema.sql
# then construct PostgresRepository(new Pool({connectionString: DATABASE_URL}))
# in place of MemoryRepository.
```

The schema enforces immutability and the double-entry balance at the **database**
layer via triggers — so the invariant holds even if application code has a bug.
That is a compliance control, not a nicety.
