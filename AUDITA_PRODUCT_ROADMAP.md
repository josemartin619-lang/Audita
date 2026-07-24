# Audita — Product Completeness Roadmap (research-backed)

**Companion to `AUDITA_EXECUTION_PLAN.md`.** That plan hardens the foundation (persistence, security, Arabic/RTL). *This* plan is about **product breadth** — the accounting features that make Audita a complete product rather than only an audit-first ledger core. Read Section 0 before the roadmap; it changes how you should read everything after it.

---

## 0. Read this first — the strategic problem inside the request

The ask was "make it the most complete version of them." I'm going to be direct, because agreeing without pushback would waste your money: **"the most complete version of all of them" is not a strategy — it's a wishlist that destroys focus.** QuickBooks has ~800 integrations and Xero ~1,000; Daftra and SMACC bundle POS + inventory + CRM + HR + payroll + fixed assets. You cannot out-*breadth* incumbents with years of head start and teams of hundreds by matching them feature-for-feature. That's a treadmill you lose by running on.

Here's the reframe that is actually winnable, and it's supported by the research:

**Completeness is the body; the audit spine is what makes it Audita.** Every Saudi competitor (Wafeq, Qoyod, Zoho, Daftra, SMACC, and the other ~10 ZATCA-approved systems) has invoicing, VAT, and increasingly POS/inventory/payroll. **None of them is built on a tamper-evident, continuously-audited, provenance-traceable core.** That core already exists in Audita and it's exactly what audit-tech leaders (MindBridge's full-population anomaly detection, DataSnipper's evidence matching, Caseware/Diligent's workpapers) sell for a premium — but those tools sit *outside* the books. Audita's unfair position is to put that audit layer *inside* a complete accounting system.

So the target is not "the most complete version of QuickBooks." It is:

> **The Saudi completeness bar (what a business there expects) + the audit spine none of the competitors have.**

Two consequences that should govern every build decision:
1. **Match the Saudi completeness bar, don't chase global parity.** The Saudi bar is concrete and finite (Section 1). Global parity (every niche integration) is infinite. Build the first, ignore the second.
2. **Every new module must feed the audit layer, or it's just catch-up.** Inventory, payroll, fixed assets — each one, as you add it, must emit into the hash-chained trail, be checkable by continuous controls, and be traceable by provenance. That's how breadth *becomes* moat instead of just closing a gap.

**Scope honesty:** what's below is realistically a multi-quarter roadmap for a small team, not a weekend of AI codegen. Payroll-with-Saudi-compliance alone is a product. Sequenced accordingly, with the highest-leverage and most-defensible work first.

---

## 1. The competitive landscape (from research, July 2026)

### 1a. The Saudi completeness bar — what "complete" means *here*
The ~15 ZATCA-approved systems cluster around a common feature set. This is the bar to hit:
- **ZATCA Phase 2 e-invoicing** — Fatoora integration, XML (UBL 2.1) + PDF/A-3, cryptographic stamp (CSID) + QR, B2B clearance / B2C 24-hour reporting, 6-year digital archive. *(Audita: architecture done, live call gated.)*
- **VAT (15%) + VAT return** filing support. *(Audita: VAT engine done; return filing missing.)*
- **Arabic-first, bilingual (AR/EN)** UI and invoices, RTL. *(Audita: engine has Arabic names; UI English-only — see engineering plan.)*
- **Multi-branch / multi-entity**. *(Audita: multi-tenant firm model exists; consolidation missing.)*
- **POS + inventory** — nearly universal among Saudi competitors (Qoyod, Daftra, SMACC, Shumoul). Retail is a huge share of the market. *(Audita: missing.)*
- **HR + payroll with GOSI / WPS / Mudad / Qiwa compliance** (Daftra, SMACC). *(Audita: missing — biggest local gap.)*
- **Fixed assets & depreciation** (SMACC). *(Audita: PPE account exists; no asset register/depreciation schedule.)*
- **Banking & reconciliation** (all). *(Audita: manual paste-reconcile done; live bank feeds gated.)*
- **Reporting dashboards + REST API** (Wafeq emphasizes self-service API). *(Audita: reports + API done.)*

Named competitors to benchmark against: **Wafeq** (e-invoicing-led, self-service Fatoora, strong API, lighter on payroll/inventory), **Qoyod** (Arabic-first, POS, retail/restaurant/manufacturing modules), **Zoho Books** (suite integration, inventory, free tier), **Daftra** and **SMACC** (broad ERPs: accounting+POS+inventory+HR+payroll+fixed assets).

### 1b. The global accounting baseline (QuickBooks Online / Xero)
The definition of a "complete" SMB accounting feature set: invoicing, estimates/quotes, bills/AP, bank feeds + reconciliation, expense tracking, inventory, projects/job costing, multi-currency, budgeting, deep financial reporting, sales-tax/VAT automation, payroll, time tracking, purchase orders, recurring transactions, tracking categories/classes (dimensions), granular user roles, mobile apps, and a large third-party app marketplace. **Notable weakness even in the giants: fixed-asset management is thin** — a differentiation opening, and one that ties naturally to the audit layer.

### 1c. The audit-tech moat (what Audita already is)
Audit-specialized tools (DataSnipper, MindBridge, Diligent HighBond, Caseware, Inflo, AuditBoard, Suralink) differentiate on **evidence documentation, control-testing workflows, continuous monitoring, full-population analysis, audit-trail integrity, and workpaper linkage** — deliberately *not* transaction processing. Audita already occupies this space (continuous controls, SHA-256 hash chain, risk scoring, working papers, "prove this number" provenance, cryptographically-verifiable sharing). **This is the asset to defend and extend, not rebuild.**

---

## 2. Feature-gap table (build target)

Status key: ✅ done · 🟡 partial · ❌ missing · 🔒 gated (needs a credential/account, see §5)

| Module | Saudi bar? | Global bar? | Audita status |
|---|---|---|---|
| Double-entry ledger, immutability, audit trail | ✅ | ✅ | ✅ |
| ZATCA e-invoicing (structure) | ✅ | — | ✅ (live 🔒) |
| VAT calc | ✅ | ✅ | ✅ |
| **VAT return preparation/filing** | ✅ | ✅ | ❌ |
| Sales invoices, AR, aging | ✅ | ✅ | ✅ |
| Vendor bills, AP, aging | ✅ | ✅ | ✅ |
| **Quotes / estimates → invoice** | ✅ | ✅ | ❌ |
| **Purchase orders → bill** | ✅ | ✅ | ❌ |
| **Expense capture (receipts/OCR)** | ✅ | ✅ | ❌ |
| Recurring transactions | ✅ | ✅ | 🟡 (templates exist) |
| Bank reconciliation (manual) | ✅ | ✅ | ✅ |
| **Bank feeds (automatic)** | ✅ | ✅ | ❌ 🔒 |
| **Multi-currency** | 🟡 | ✅ | ❌ |
| **Inventory** | ✅ | ✅ | ❌ |
| **POS** | ✅ | 🟡 | ❌ |
| **Fixed assets + depreciation** | ✅ | 🟡 | ❌ |
| **Payroll (run, payslips)** | ✅ | ✅ | ❌ |
| **Saudi payroll compliance: GOSI / WPS / Mudad / Qiwa** | ✅ | — | ❌ 🔒 |
| **Projects / job costing** | 🟡 | ✅ | ❌ |
| **Dimensions / cost centers / tracking** | 🟡 | ✅ | ❌ |
| **Multi-entity consolidation** | ✅ | 🟡 | ❌ |
| Budgets vs actuals | 🟡 | ✅ | ❌ |
| Financial statements (P&L, BS, CF) + PDF | ✅ | ✅ | ✅ |
| Report builder / management dashboards | ✅ | ✅ | 🟡 |
| REST API | ✅ | ✅ | ✅ |
| Granular roles/permissions | ✅ | ✅ | 🟡 (4 roles) |
| Arabic / RTL UI | ✅ | — | ❌ (in eng plan) |
| Mobile | 🟡 | ✅ | ❌ |
| **Audit spine: continuous controls, provenance, tamper-evidence, verifiable sharing** | ❌ (nobody) | ❌ (nobody) | ✅ **← the moat** |

---

## 3. The roadmap — modules in build order

Ordering logic: (1) finish the transactional core to reach the Saudi bar, (2) add the two biggest local-market modules (inventory/POS, payroll+compliance) because they're what make a Saudi business take you seriously, (3) thread the audit spine through each so breadth becomes moat, (4) platform depth last. **Do the foundation work in `AUDITA_EXECUTION_PLAN.md` first** — building payroll on an in-memory demo store is wasted effort.

Each module below carries: **why** (parity = catching up, or diff = pulling ahead), the **audit-spine tie-in** (mandatory), rough **effort**, and **gated?** flag.

### M1 — Complete the transactional core (parity; unblocks everything)
Quotes/estimates, purchase orders, expense capture, finish recurring, multi-currency, budgets-vs-actuals.
- **Why:** parity. These are table stakes on both the Saudi and global bars; their absence makes Audita look like a prototype.
- **Audit tie-in:** every quote→invoice and PO→bill conversion is a linked, hash-chained event; budgets enable variance controls (actual vs budget as a finding rule).
- **Effort:** medium. Most reuse the existing ledger/subledger seams.
- **Gated?** No (multi-currency needs an FX-rate source — a free/public rate feed is fine; not gated).

### M2 — Inventory & POS (parity, but Saudi-critical)
Stock items, valuation (weighted-avg/FIFO), stock movements, purchase receipts, COGS on sale, low-stock; a POS surface for retail.
- **Why:** parity, but heavily weighted — most Saudi competitors have it and retail is a dominant segment. Without it you're excluded from a large market slice.
- **Audit tie-in:** inventory adjustments are exactly where fraud/error hides — every stock adjustment flows through continuous controls (round-number, manual-adjustment, velocity rules already exist), and provenance traces COGS to movements. **This is where Audita's audit spine beats a plain POS.**
- **Effort:** large.
- **Gated?** No.

### M3 — Fixed assets & depreciation (differentiation opening)
Asset register, acquisition, depreciation schedules (straight-line/reducing-balance), disposals, gain/loss, IFRS componentization.
- **Why:** **differentiation** — even QuickBooks/Xero are thin here, and it maps perfectly onto IFRS + the audit story. A firm auditing clients cares deeply about asset existence and depreciation correctness.
- **Audit tie-in:** depreciation runs post to the hash chain; existence assertions become working papers; disposals get provenance. Pitch: "assets you can prove."
- **Effort:** medium.
- **Gated?** No.

### M4 — Payroll + Saudi compliance (the biggest local moat)
Payroll runs, payslips, end-of-service, leave; **GOSI** contributions (employer + employee, monthly), **WPS** SIF bank-file generation (due by the 10th; non-compliance fines are per-employee), **Mudad** e-payroll/compliance, **Qiwa/Nitaqat** Saudization tracking.
- **Why:** **the deepest local moat.** Global tools (QuickBooks/Xero) do NOT do GOSI/WPS/Mudad — this is where a Saudi-built product wins outright, and where competitors like Daftra/SMACC already play. A serious Saudi accounting product is expected to handle payroll compliance.
- **Audit tie-in:** payroll is a top fraud/error surface; every run is audited, ghost-employee and duplicate-payment controls extend the existing rules engine, WPS/GOSI submissions become provable evidence.
- **Effort:** very large (this is a product inside the product). Build the payroll engine + payslips + GOSI/WPS *file generation* now (fully buildable); the **live Mudad/WPS bank submission is 🔒 gated** on credentials/accreditation — generate the compliant SIF/GOSI files and stop at the upload boundary.
- **Gated?** Partially (engine + file generation buildable; live submission gated).

### M5 — Dimensions, projects, and multi-entity consolidation
Cost centers / tracking categories on every line; project/job costing; consolidation across a firm's clients/entities (eliminations, inter-company).
- **Why:** parity (dimensions/projects) + Saudi bar (multi-entity/branch consolidation). The firm-managing-many-clients model makes consolidation natural for Audita.
- **Audit tie-in:** consolidation with a tamper-evident trail per entity is a genuinely differentiated group-audit story; inter-company entries get related-party controls (already exist).
- **Effort:** medium-large.
- **Gated?** No.

### M6 — Reporting depth, VAT return, management dashboards
Custom/report builder, VAT return preparation (ZATCA-format), cash-flow forecasting, KPI dashboards, drill-down everywhere.
- **Why:** parity + Saudi bar (VAT return). Reporting is where users live daily; the VAT return closes a concrete compliance gap.
- **Audit tie-in:** every figure already has provenance — make "prove this number" reachable from every report cell. That's a reporting experience no competitor can copy without a tamper-evident core.
- **Effort:** medium.
- **Gated?** No (VAT *filing* submission may be gated; *preparation* is not).

### M7 — Extend the audit spine into a full audit suite (double down on the moat)
This is the "pull ahead" investment, layered as the modules above generate data:
- **Full-population analytics** (MindBridge-style): score 100% of transactions per period, not just per-entry rules; ensemble risk model with explainable drivers.
- **PBC / request lists** (Suralink-style): manage client document requests and evidence collection inside the platform.
- **Sampling & tests of detail** (DataSnipper-style): statistical sampling, document matching/OCR tie-outs, tickmarks — but native to the ledger, not bolted onto Excel.
- **Engagement management** (Caseware/Diligent-style): plan, assign, sign off, and archive audit engagements with the immutable trail as the workpaper backbone.
- **Why:** **this is the whole thesis.** Competitors sell these as separate premium tools *outside* the books; Audita has them *inside*. Effort here compounds the moat.
- **Effort:** large, ongoing.
- **Gated?** No.

### M8 — Platform depth (last)
Granular custom roles/permissions, mobile (responsive PWA before native), a public API + webhook/app ecosystem, audit-log exports.
- **Why:** parity, but low urgency — do not front-load an app marketplace to "match 800 integrations." A focused API beats a sprawling marketplace at this stage.
- **Effort:** medium, ongoing.
- **Gated?** No.

---

## 4. What to deliberately NOT chase (focus discipline)

- **Global integration parity** (matching 800–1,000 marketplace apps). Ship a clean API; let integrations follow demand. Chasing this is the treadmill.
- **Becoming your own ZATCA solution provider.** Integrate an accredited provider / complete Fatoora onboarding; don't rebuild accreditation.
- **Every vertical at once** (restaurant, pharmacy, real-estate modules like Qoyod/DEQA/Nodhom). Pick the segment your first customer is in; generalize later.
- **Native mobile apps before a responsive web app.** PWA first.
- **Out-featuring incumbents on commodity accounting.** Reach the Saudi bar, then spend every extra unit of effort on the audit spine (M7), because that's the only thing that can't be copied by a competitor without rebuilding on a tamper-evident core they don't have.

---

## 5. Gated items (need something only Jose/the business can supply)
- **Live bank feeds** — a Saudi bank-aggregator (open-banking) agreement/credentials. Build the import/reconcile side; stop at the live feed.
- **Live WPS / Mudad / GOSI submission** — employer registration + platform credentials. Build the payroll engine and the compliant file generation; stop at upload.
- **Live ZATCA clearance/reporting** — Fatoora onboarding + CSID. Structure is built; the live call is gated.
- **FX rates for multi-currency** — *not* gated (public rate feeds exist); noted only so it isn't confused with the above.

---

## 6. How this sequences with the engineering plan

`AUDITA_EXECUTION_PLAN.md` (foundation) is a **prerequisite**, not a parallel track. Persistence, validation, security, and Arabic/RTL must land before breadth modules — otherwise you're building payroll and inventory on demo data that vanishes on restart. Recommended overall order:

1. **Engineering plan Phases 1–3** (persistence, validation, security) — foundation.
2. **Roadmap M1** (transactional core) — reach the near-parity bar.
3. **Engineering plan Phase 4** (Arabic/RTL) — Saudi credibility on the surface.
4. **Roadmap M2 + M4** (inventory/POS, payroll+compliance) — the two modules that make a Saudi business take you seriously.
5. **Roadmap M3, M5, M6** (fixed assets, consolidation, reporting/VAT return).
6. **Roadmap M7** (audit suite) — thread throughout, invest heavily once data exists.
7. **Roadmap M8 + engineering Phases 5–6** (platform, cleanup, observability) — ongoing.

**One rule above all:** as each module ships, it must post to the hash-chained trail, be reachable by continuous controls, and be traceable by provenance. A module that doesn't feed the audit spine is just catch-up; a module that does is why Audita wins.

---

## Sources
- Wafeq — ZATCA Phase 2 accounting software features: https://www.wafeq.com/en/business-hub/for-business/best-accounting-software-trusted-by-zatca-and-compliant-for-phase-2-e-invoicing
- Azdan — 15 ZATCA-approved accounting systems in Saudi Arabia (2026): https://www.azdan.com/blog/15-accounting-systems-approved-by-zatca-in-saudi-arabia-2026
- Qoyod — Saudi cloud accounting features: https://www.qoyod.com/en/accounting-software/accounting/
- Zoho Books — ZATCA Phase 2 e-invoicing (KSA): https://www.zoho.com/sa/books/e-invoicing/
- QuickBooks Online vs Xero feature comparison: https://www.wishup.co/blog/quickbooks-vs-xero/
- ZenHR — Saudi payroll compliance (GOSI, WPS, Mudad): https://blog.zenhr.com/en/payroll-compliance-in-saudi-arabia-gosi-wps-mudad-explained
- DataSnipper — best audit software for accountants (audit-tech capabilities): https://www.datasnipper.com/resources/best-audit-software-for-accountants
