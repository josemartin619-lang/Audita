# Audita — Handoff Report: Jurisdiction Generalization (GCC) + Current State

**Audience:** the model/engineer continuing the build (you). **Purpose:** a single source of truth to keep adding to Audita without re-deriving context. Read Sections 1–3 before writing code; Section 4 is the immediate task spec.

This report sits alongside two existing plans in the repo/project:
- `AUDITA_EXECUTION_PLAN.md` — production-foundation hardening (persistence, validation, security, Arabic/RTL). **The foundation. Do this first.**
- `AUDITA_PRODUCT_ROADMAP.md` — product breadth (inventory, payroll, fixed assets, audit suite). **The long game.**
- **This report** — the *jurisdiction* refactor that must land before the roadmap's breadth modules, so features aren't built against hardcoded Saudi constants.

---

## 1. Ground truth — the verified current state (do not trust memory, this is checked)

- **Version:** `0.6.0-ksa`. **Tests:** ~72, all green (`npx vitest run`). **Typecheck:** clean (`npm run typecheck`).
- **The codebase is Saudi-only.** The earlier Colombian pivot is **complete and irreversible in the working tree**: `src/domain/accounts.ts` is the IFRS/KSA chart with Arabic names; VAT is 15%; currency is SAR; the e-invoicing provider is `ZatcaEInvoicingProvider` (UUID + ICV + PIH chain + TLV QR — *simulated*, no live ZATCA call). The last full-Colombia commit is `233478d` (v0.9) if you ever need the Colombian domain as reference.
- **What exists and works:** double-entry ledger (bigint minor units, never float), SHA-256 hash-chained immutable audit trail, continuous controls, risk scoring, working papers, "prove-this-number" provenance, cryptographically-verifiable sharing, AR/AP subledger + aging, financial statements + integrity-stamped PDF, VAT/tax-position report, recurring templates, period lock, maker-checker review, REST API, 4-role auth, manual bank reconciliation. UI is **English-only** (Arabic/RTL is in the foundation plan).
- **What's scaffolded but orphaned** (details in `AUDITA_EXECUTION_PLAN.md`): Postgres layer (`src/persistence/pg/`, has transactions) is **not wired to the running app** — `main.ts` boots in-memory demo data (`seedFirm()` + `seedUsers()`), so **data is lost on restart**. Users are in-memory demo users (`@audita.co`, password `audita`). No input-validation library. `Dockerfile`, `docker-compose.yml`, CI (`.github/workflows/ci.yml`), and the prod-secret guard already exist — do not recreate them.
- **Seams that already exist and make this refactor cheaper:** `FirmWorkspace` accepts a per-client `repoFactory` **and** a per-client `providerFactory` (`src/services/firmWorkspace.ts`). The e-invoicing `EInvoicingProvider` interface is already the jurisdiction seam for invoicing. The domain already uses **semantic account keys** `ACCT.*` (`src/domain/accounts.ts`) rather than raw codes in most places — that is the hook the whole refactor hangs on.

---

## 2. The strategic decision locked this session (the mandate)

**The pivot is Colombia → GCC, Saudi first. Not two product lines — a redirect.** Colombia was scaffolding; it is not extended forward.

**"GCC" is not one target — it is at least three, and only one is buildable today** (verified with current sources, see §7):
- **Saudi Arabia** — 15% VAT (highest in GCC), ZATCA Phase 2 e-invoicing fully mandatory now. CSID / hash-chain / QR model. **The only mature, enforced target. Build against it.**
- **UAE** — 5% VAT; e-invoicing on a **Peppol five-corner network with Accredited Service Providers (PINT AE)** — *structurally different from ZATCA*, not a config relabel. Voluntary phase live; first mandatory wave 2027 (large taxpayers). **Build later, as its own real Peppol adapter.**
- **Oman** — 5% VAT; "Fawtara" e-invoicing on an **OpenPeppol testbed**, phased 2026–2027. **Clusters with UAE, not Saudi** — the UAE Peppol adapter will likely serve Oman too.
- **Bahrain** — 10% VAT; e-invoicing status unverified. Do not spec until confirmed.
- **Qatar / Kuwait** — **no VAT law in force.** Qatar's is drafted with no date; Kuwait's is stalled. **Nothing to build.** Not a backlog item.

**Approach:** generalize the domain so **chart of accounts, tax rules, currency, e-invoicing provider, withholding, jurisdiction-specific control rules, and locale are jurisdiction config** — not hardcoded constants. Saudi is jurisdiction one (real, shipping).

**Two corrections to the originally-proposed plan (these are decisions, not options):**
- **A — The second instance is a thin proof-fixture, NOT a re-imported Colombia market.** A one-jurisdiction abstraction is unfalsifiable, so a second instance is needed *today* to prove the seam generalizes. But re-importing full Colombia drags in withholding-tax + DIAN machinery for a market that will never ship — maintenance cost for zero customers. Instead build a **minimal synthetic/stripped fixture** (small chart, a different VAT rate, a different currency, a stub provider) whose *only* job is to prove the config seam. It retires when UAE/Oman becomes the real second jurisdiction.
- **B — The config boundary is wider than "COA + tax + currency + provider."** That omission is exactly what caused the Spanish-string leak we already cleaned. Jurisdiction config **must also own**: withholding tax (present in COL, absent in KSA), jurisdiction-specific control rules and their compliance-message strings (the numbering-gap rule hardcodes ZATCA "ICV / PIH" text today), and default locale.

---

## 3. Why now, and why this shape

The VAT rate `1500` is currently hardcoded in **three** places (`src/services/invoiceService.ts`, `src/api/seed.ts`, `src/api/server.ts`) — a divergence bug waiting to happen. Currency `SAR` is baked into `money.ts`. The ZATCA compliance string is baked into `controls/rules.ts`. The withholding fields still live in `invoiceService.ts` (KSA-nulled to `0n`). Every one of these is a jurisdiction concern masquerading as a constant. Extracting them into one config object is both the fix for the triple-defined rate *and* the seam that lets UAE/Oman slot in later without touching the domain.

---

## 4. IMMEDIATE TASK — Jurisdiction generalization + Saudi adapter

**Goal:** introduce a `Jurisdiction` config object; make Saudi one instance of it; add a thin proof-fixture as a second; leave a clean seat for a future UAE/Peppol jurisdiction. **No behavior change for the Saudi path — all ~72 tests stay green.**

### 4.1 Define the config shape
Create `src/domain/jurisdiction.ts`:
```
export type AcctKey = keyof typeof ACCT;   // reuse existing semantic keys

export interface Jurisdiction {
  id: string;                       // 'KSA' | 'FIXTURE' | (future) 'UAE'
  name: string;
  defaultLocale: 'en' | 'ar' | 'es';
  currency: {
    code: string;                   // 'SAR'
    minorDigits: number;            // 2
    // formatting: grouping + symbol placement (replaces hardcoded SAR in money.ts)
    format(minor: bigint, withCents?: boolean): string;
  };
  chart: AccountDef[];              // the COA for this jurisdiction
  accounts: Record<AcctKey, string>;// semantic key -> account code (e.g. OUTPUT_VAT -> '2100')
  tax: {
    vatStandardBps: number;         // 1500 for KSA — the SINGLE source of truth
    vatAccounts: { output: string; input: string };
    withholding:
      | { enabled: false }
      | { enabled: true; receivable: string; payable: string; kinds: WithholdingKind[] };
  };
  eInvoicing: {
    makeProvider(meta: ClientMeta): EInvoicingProvider;   // ZATCA | Peppol | stub
    numberingGapMessage(code: string): string;            // jurisdiction-specific control text
  };
}
```
Keep `ACCT` as the semantic **key** enum in `accounts.ts`, but move the **key→code mapping and the AccountDef chart** into the jurisdiction. The domain keeps saying `ACCT.OUTPUT_VAT`; the jurisdiction resolves it to a code.

### 4.2 Thread the jurisdiction through (the actual refactor)
These functions currently `import { ACCT }` statically and assume the KSA chart. Change them to receive the active jurisdiction (or its resolved `accounts` map) as a parameter, resolved once at `FirmWorkspace`/service construction:
- `src/domain/reports.ts` — `incomeStatement`, `balanceSheet`, `cashFlowStatement`, `cashFlowActivity`, `CASH_ACCOUNTS`.
- `src/domain/taxReport.ts` — `taxPosition` (VAT + withholding accounts).
- `src/domain/controls/rules.ts` — `manualCashAdjustment` (cash/bank codes) and `invoiceSequenceGaps` (the ZATCA message → `jurisdiction.eInvoicing.numberingGapMessage`).
- `src/services/invoiceService.ts` — replace `const IVA_BPS = 1500` with `jurisdiction.tax.vatStandardBps`; gate the withholding block on `jurisdiction.tax.withholding.enabled`.
- `src/domain/money.ts` — `formatCOP` (rename to `formatMoney`) takes currency formatting from the jurisdiction instead of hardcoding `SAR`. (Coordinate with the money-naming cleanup in the foundation plan Phase 5 so this rename happens once.)
- `src/api/seed.ts` and `src/api/server.ts` — consume `jurisdiction.tax.vatStandardBps`; kill the two extra hardcoded `1500`s.
- `FirmWorkspace` (`src/services/firmWorkspace.ts`) — accept a `jurisdiction: Jurisdiction` (default: the KSA instance) and pass it into the services it constructs; default `providerFactory` becomes `jurisdiction.eInvoicing.makeProvider`.

### 4.3 Provide the instances
- `src/domain/jurisdictions/ksa.ts` — the Saudi `Jurisdiction`: the existing IFRS chart + Arabic names, VAT 1500, no withholding (`enabled:false`), `ZatcaEInvoicingProvider`, `defaultLocale:'ar'`, ZATCA numbering message. This is just relocating today's hardcoded values into the object.
- `src/domain/jurisdictions/fixture.ts` — the **proof-fixture** (Correction A): a deliberately different, minimal jurisdiction — small chart, VAT e.g. 1000 bps, currency e.g. `XTS`/a test code, withholding **enabled** (to exercise that axis KSA leaves off), a `StubEInvoicingProvider`. Mark it clearly as non-shipping. Its purpose is solely to prove the seam.
- Leave a documented empty seat: `// jurisdictions/uae.ts — future: Peppol/PINT AE provider, VAT 500, withholding disabled. Do NOT build yet.`

### 4.4 Non-goals (do not do these now)
- Do **not** build the UAE/Peppol provider or invent its spec — the mandate is 2027 and the field spec is a separate real integration.
- Do **not** re-import the Colombian domain from git as a live jurisdiction (Correction A).
- Do **not** add Qatar/Kuwait/Bahrain jurisdictions — no confirmed regime to implement.
- Do **not** change any Saudi-visible behavior; this is a pure refactor + one test fixture.

### 4.5 Acceptance criteria
1. All ~72 existing tests still green; typecheck clean; no Saudi output changes (findings, reports, invoices, PDF identical).
2. The VAT rate `1500` appears **exactly once** in the codebase (inside the KSA jurisdiction); the three hardcoded copies are gone.
3. New test file `test/jurisdiction.test.ts` proves the seam by running core domain logic under **both** the KSA jurisdiction and the fixture jurisdiction and asserting they differ correctly: different currency in `formatMoney`, different VAT on an invoice, withholding present under the fixture and absent under KSA, and the numbering-gap message text differing. **This test failing to compile without a second jurisdiction is the proof the abstraction is real, not Saudi-with-indirection.**
4. Adding a hypothetical third jurisdiction requires touching **only** a new file under `src/domain/jurisdictions/`, not the domain functions.

### 4.6 Commit boundaries
`refactor(domain): extract Jurisdiction config; KSA becomes an instance` → `test(jurisdiction): prove the seam with a fixture jurisdiction` → `chore: collapse triple-defined VAT rate into jurisdiction`.

---

## 5. Execution order across all three plans

1. **Foundation** — `AUDITA_EXECUTION_PLAN.md` Phases 1–3 (persistence, validation, security). Building jurisdictions/features on in-memory demo data is wasted work.
2. **This report** — jurisdiction generalization + Saudi adapter + proof-fixture. Pure domain, low-risk, best done before more jurisdiction-specific code accretes.
3. **Foundation Phase 4** — Arabic/RTL (the jurisdiction already carries `defaultLocale` + Arabic account names, so this composes).
4. **Roadmap** — breadth modules (`AUDITA_PRODUCT_ROADMAP.md`), each built jurisdiction-aware from the start and each feeding the audit spine.
5. When UAE/Oman e-invoicing firms up (2026–2027): add `jurisdictions/uae.ts` with a real Peppol/PINT AE provider; retire the fixture if desired.

---

## 6. Guardrails and gated items

**Guardrails (every task):** keep all tests green (`npx vitest run` after each), never weaken a test to pass, `npm run typecheck` clean, commit per logical unit. The five invariants are sacred: money is bigint minor units (never float); double-entry can't be unbalanced; posted entries are append-only; trial balance sums to zero; every event is hash-chained. Domain (`src/domain/`) imports nothing from `api/` or `persistence/`.

**Gated — do not build, leave the seam (need a credential/account only the business can supply):** live ZATCA clearance/reporting (onboarding + CSID); live UAE/Oman Peppol (Accredited Service Provider agreement); live bank feeds (aggregator); live payroll submission (WPS/Mudad/GOSI). Build up to each boundary; stop at the live call.

---

## 7. Sources (jurisdiction facts, verified July 2026)
- UAE Peppol / PINT AE e-invoicing, phased 2026–2027: https://www.cleartax.com/ae/e-invoicing-uae
- Oman "Fawtara" e-invoicing on OpenPeppol testbed, 2026–2027: https://www.vatcalc.com/oman/oman-e-invoicing-jan-2023/
- GCC VAT rates by country (KSA 15%, UAE/Oman 5%, Bahrain 10%, Qatar/Kuwait none in force): https://gccaccounting.com/vat-in-the-gcc-country-by-country-comparison-uae-ksa-oman-bahrain-qatar/
