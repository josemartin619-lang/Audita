# Audita — Production-Foundation Execution Plan (for Sonnet 5)

**You are executing this plan. You have no prior context on this project. Read this whole document before touching code.**

Scope of this plan (decided by the product owner, Jose):
- **Do:** all code work that does NOT require Jose to supply an external account or credential — persistence wiring, validation, security hardening, Arabic/RTL, cleanup, testing.
- **Priority:** production-grade foundation first (persistence, validation, security), user-facing polish (Arabic/RTL) second, cosmetic cleanup last.
- **Do NOT:** build any of the "gated" items in the final section. They need credentials/accounts that don't exist yet. Faking them is worse than leaving the clean seam that's already there.

---

## 0. What Audita is (so you make aligned decisions)

Audita is a **double-entry accounting engine for accounting/audit firms in Saudi Arabia** where **the audit layer is the product**, not a bolt-on. A firm manages multiple client companies; each client's books are continuously checked for anomalies, every event is in a tamper-evident hash chain, and any figure can be traced to its evidence.

**The strategic moat (do not undermine it):** ZATCA (Saudi tax authority) Phase 2 e-invoicing mandates a **Previous-Invoice-Hash (PIH) chain** — each invoice cryptographically links to the previous one. Audita's core audit trail is *already* a SHA-256 hash chain. Compliance and the product are the same mechanism. Every decision should preserve the integrity/traceability guarantees, never trade them for convenience.

**Five invariants that are sacred. Never weaken a test that protects these:**
1. Money is `bigint` minor units (halalas). **Never a float, ever.**
2. Double-entry: an entry that doesn't balance cannot be constructed (`normalizeLines` throws).
3. Append-only: posted entries are immutable; corrections are reversing entries. Enforced in code AND by Postgres triggers.
4. The trial balance always sums to zero (property-tested over 200 random runs).
5. Every event is in a hash-chained audit trail; tampering breaks `verify()`.

**Current version:** `0.6.0-ksa`. **Tests:** 71 passing (`npx vitest run`). The engine is fully localized to Saudi Arabia (IFRS chart of accounts with Arabic account names, 15% VAT, SAR currency, ZATCA e-invoicing provider, English UI). The UI is **English-only** right now.

---

## 1. How to run and verify (do this first, confirm 71 green)

```bash
cd <repo>
npm install
npm run typecheck      # strict TS, must be clean
npx vitest run         # must show 71 passed before you change anything
npm run build          # tsc -> dist/
node dist/api/main.js  # http://localhost:3000  (UI + JSON API)
```
Demo logins (password `audita`): `ana@audita.co` (partner), `carlos@audita.co` (accountant), `sofia@audita.co` (staff).

Postgres path (already wired for tests, NOT for the app yet):
```bash
docker compose up db          # starts postgres:16
psql "$DATABASE_URL" -f src/persistence/pg/schema.sql
npm run test:pg               # pg integration smoke (tsx scripts/pgSmoke.ts)
```

---

## 2. Non-negotiable ground rules for every task

1. **Keep all existing tests green.** Run `npx vitest run` after every task. If a change legitimately alters behavior, update the test to assert the *new correct* behavior — never delete an assertion or loosen it just to get green. If you can't keep an invariant test passing, stop and reconsider the change.
2. **Run `npm run typecheck` after every task.** Strict TS, zero errors.
3. **Commit per completed task** with a clear message. Use conventional prefixes (`feat:`, `fix:`, `refactor:`, `test:`, `chore:`). End each commit body with:
   `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
4. **Add tests for every new behavior.** This codebase's identity is that it's tested. New endpoints/logic ship with tests in `test/`.
5. **No scope creep.** Do not add payroll, inventory, POS, multi-currency, or a new UI framework. Do not "improve" working code that isn't in a task.
6. **Preserve the seams.** The domain (`src/domain/`) depends on nothing. Services orchestrate domain + a `Repository` + an `EInvoicingProvider`. Infrastructure implements interfaces. Never make `src/domain/` import from `src/api/` or `src/persistence/`.
7. **Ask nothing of Jose.** If a task appears to need a credential/account, it's in the gated list — skip it and leave the seam.

---

## 3. Accurate current-state map (do not rebuild things that exist)

**Already exists and works — do NOT recreate:**
- `Dockerfile`, `docker-compose.yml` (app + postgres:16), `.env.example`, `.github/workflows/ci.yml` (runs typecheck + tests + loads schema + pg smoke).
- Postgres layer: `src/persistence/pg/schema.sql` (append-only + double-entry enforced by DB triggers) and `src/persistence/pg/pgRepo.ts` (implements `Repository`, has `BEGIN/COMMIT/ROLLBACK`).
- `FirmWorkspace` (`src/services/firmWorkspace.ts`) **already accepts a `repoFactory?: (clientId) => Repository`** and defaults to `MemoryRepository`. Wiring Postgres = supplying that factory.
- Prod-secret guard: `main.ts` already refuses to boot in `NODE_ENV=production` if `AUDITA_JWT_SECRET` is unset/default.
- Auth (`src/api/auth.ts`): scrypt password hashing (`salt:hash`), hand-rolled HS256 JWT with expiry (HS256-only, no alg-confusion), `UserStore` (in-memory), `seedUsers()`.

**Stubbed / orphaned / incomplete — this is the work:**
- **Persistence is orphaned.** `src/api/main.ts` always boots `seedFirm()` (in-memory demo firm) + `seedUsers()` (in-memory demo users). The verified Postgres layer is never used by the running app. **Data is lost on restart.** This is the #1 foundation gap.
- **Users are in-memory demo users** with `@audita.co` emails and password `audita`. No real-firm provisioning.
- **No input-validation library.** Endpoints coerce with `String(x)` and `req.body ?? {}`. No consistent 400s. (No `zod` in deps.)
- **Transactions stop at the repo.** `pgRepo.saveEntry` is transactional, but a *service* op that spans several repo calls (issue invoice = post ledger entry + open receivable + save invoice record) is not wrapped in one transaction.
- **UI is English-only.** i18n is inline dictionaries in `public/index.html` (an `en` map and a vestigial `es` map). Account model already carries Arabic names (`nameAr` in `src/domain/accounts.ts`).
- **Cosmetic Spanish/Colombian leftovers:** `src/index.ts` CLI demo prints Spanish; `main.ts` startup banner says "en"; demo emails/names are Colombian; `src/api/pdf.ts` keeps a Spanish `es` label block; `src/api/serialize.ts` and `taxReport.ts` use Spanish JSON keys (`retencionesAFavor`, `retencionesPorPagar`); money helpers are named `pesos`/`toPesosNumber`/`formatCOP` (they mean minor-units / major-units / format — misleading but not buggy); risk-band enum values are `alto/medio/bajo` (rendered as HIGH/MEDIUM/LOW — internal token, not shown as Spanish).

---

## 4. The plan (ordered — do phases in sequence; tasks within a phase can interleave)

### PHASE 1 — Persistence & multi-tenancy (biggest foundation gap)

**Objective:** the running app can persist to Postgres and survive a restart, with strict tenant isolation, while `MemoryRepository` remains the default for tests/dev.

**1.1 — Decide and implement the tenancy model.**
The current design is "one `Repository` per client" (`repoFactory(clientId)`). `pgRepo` must not let one client's query see another's rows. **Recommended:** a single Postgres database with a `tenant_id` (= firmId + clientId, or a composite) column on every table, and a `PostgresRepository` instance constructed *bound to one tenant* so every query is filtered by that tenant and every insert stamps it. Keep the `repoFactory` seam exactly as-is; the factory returns a tenant-bound `PostgresRepository`. Do NOT switch to schema-per-tenant (operational overhead, no benefit here).
- Update `schema.sql`: add `tenant_id text not null` to every table, composite indexes/PKs including it, and make the immutability + balance triggers tenant-agnostic (they already fire per-row).
- Update `pgRepo.ts` to take a `tenantId` in its constructor and filter/stamp every query. Preserve the existing `BEGIN/COMMIT/ROLLBACK`.
- Acceptance: `npm run test:pg` passes; add a test proving tenant A cannot read tenant B's entries through a tenant-A-bound repo.

**1.2 — Wire repo selection by environment.**
- In `main.ts` (or a small `src/api/bootstrap.ts`), choose the repo factory: if `DATABASE_URL` is set, build a `pg.Pool` once and pass `repoFactory = (clientId) => new PostgresRepository(pool, tenantId(firmId, clientId))`; otherwise default to in-memory.
- On boot with Postgres: run `schema.sql` idempotently (guard with `IF NOT EXISTS` / a migrations table — see 1.3) before serving.
- Acceptance: `DATABASE_URL=... node dist/api/main.js` boots against Postgres; creating a client + posting entries survives a process restart. In-memory still works with no `DATABASE_URL`.

**1.3 — Minimal migration runner.**
- Add a `migrations/` dir and a tiny runner (a `schema_migrations` table + numbered `.sql` files applied in order in a transaction). Convert the current `schema.sql` into `migrations/0001_init.sql`. No external migration framework.
- Acceptance: running the app twice does not error; `npm run test:pg` still green; CI updated to apply migrations instead of raw `schema.sql`.

**Commit(s):** `feat(persistence): tenant-scoped Postgres backend wired to the app` etc.

---

### PHASE 2 — Input validation, error handling, service-level transactions

**Objective:** every endpoint validates input and returns consistent errors; multi-step service operations are atomic.

**2.1 — Add `zod` and a validation layer.**
- `npm i zod`. Define request schemas (co-locate near each route or in `src/api/schemas.ts`). Replace `String(x)`/`req.body ?? {}` coercion in `src/api/server.ts` with `schema.parse`.
- Add one Express error middleware that turns a `ZodError` into `400 {error, issues}` and any thrown domain error into a structured JSON error (never leak stack traces in `NODE_ENV=production`).
- Acceptance: malformed bodies get `400` with a useful message (add tests); all existing API tests still pass (adjust them only if they relied on loose coercion).

**2.2 — Service-level atomicity.**
- Wrap multi-repo service operations (at minimum `InvoiceService.issue` = post entry + open receivable + save invoice; vendor-bill creation; payment application) so that with the Postgres backend they commit or roll back as a unit. Add a `Repository.transaction(fn)` method (no-op/pass-through for `MemoryRepository`, real `BEGIN/COMMIT/ROLLBACK` for `PostgresRepository`) and use it in the services.
- Acceptance: add a pg test that forces a mid-operation failure and asserts nothing partial persisted (no orphan receivable without its ledger entry).

**2.3 — Consistent error taxonomy.**
- Introduce typed domain errors (e.g. `ValidationError`, `NotFoundError`, `ConflictError`, `AuthError`) and map them to HTTP status codes in one place. Replace ad-hoc `res.status(...)` scattered in routes where it improves consistency (don't churn working handlers pointlessly).
- Acceptance: 404 for unknown client, 409 for overpayment/duplicate, 401/403 for auth — all covered by tests.

**Commit(s):** `feat(api): zod validation + structured errors`, `feat(services): atomic multi-step operations`.

---

### PHASE 3 — Auth & security hardening

**Objective:** authentication and authorization are production-safe; no demo defaults reachable in production.

**3.1 — Persist users.**
- Move `UserStore` behind the persistence layer: a `users` table (id, email unique, name, role, firm_id, password_hash, created_at) and a `PostgresUserStore` implementing the same interface as the in-memory one. Select by `DATABASE_URL` like the repo.
- Acceptance: users survive restart on Postgres; in-memory still used for tests.

**3.2 — Real-firm provisioning + guard the demo seed.**
- Add a one-command bootstrap to create a firm + an initial admin user from env (`AUDITA_ADMIN_EMAIL`, `AUDITA_ADMIN_PASSWORD`) — e.g. `npm run provision`. Only seed demo firm/users when `NODE_ENV !== 'production'` AND `AUDITA_SEED_DEMO=1`. In production with no users, the app should instruct the operator to run provisioning, not silently seed `ana@audita.co`.
- Acceptance: `NODE_ENV=production` never exposes demo logins; test the seed guard.

**3.3 — Token lifecycle + login hardening.**
- Confirm JWT expiry is enforced on verify (reject expired). Add refresh (short-lived access token + longer refresh token, or a sliding session — pick the simpler that fits the hand-rolled JWT; document the choice). Keep HS256-only.
- Enforce a minimum password policy on provisioning/user creation. Keep the existing login rate-limiter.
- Acceptance: expired token → 401 (test); weak password rejected at creation (test).

**3.4 — Authorization audit.**
- Review every route in `src/api/server.ts` for the correct `requireRole(...)`. Confirm a `viewer` cannot mutate, `staff` cannot self-approve (maker-checker), tenant scoping can't be bypassed via a path param. Write tests for the two or three most sensitive routes (post entry, review/approve, change finding status, lock period).
- Acceptance: cross-role and cross-tenant access attempts are denied, with tests.

**Commit(s):** `feat(auth): persisted users + provisioning`, `feat(auth): token lifecycle & authz hardening`.

---

### PHASE 4 — Arabic language + RTL (the Saudi-market requirement)

**Objective:** the UI is fully usable in Arabic with correct right-to-left layout; the account model's Arabic names are surfaced; the retired Spanish UI is removed.

**4.1 — Real i18n architecture.**
- Replace the inline `en`/`es` dictionaries in `public/index.html` with a clean two-locale catalog: `en` and `ar`. Remove `es` entirely (it's vestigial). Keep it a single self-contained file if practical (the app deliberately has no build step for the UI); a small `LOCALES = { en:{...}, ar:{...} }` object is fine. Every user-facing string must have an `ar` translation — no English fallbacks left visible in Arabic mode.
- Acceptance: language switch top-right toggles EN ⇄ AR; no untranslated strings in AR mode (scan the rendered `body.innerText` for Latin-only labels in a headless check).

**4.2 — RTL layout.**
- When locale is `ar`, set `document.documentElement.dir = 'rtl'` and `lang = 'ar'`, and make the CSS direction-aware (use logical properties / mirror the grid, number columns stay left-aligned for figures as is conventional for financial tables — verify with a screenshot). Ensure the Playfair/Spectral display fonts fall back to a proper Arabic webfont (e.g. bundle an Arabic face under `public/fonts` — the app serves fonts locally, no CDN).
- Acceptance: headless screenshot in AR mode shows a correctly mirrored layout; numerals and SAR amounts render correctly; no clipped or overlapping text.

**4.3 — Surface Arabic account names + Arabic-format the invoice artifacts.**
- Use `nameAr` from `src/domain/accounts.ts` in the UI account labels and the PDF when locale is `ar`.
- The ZATCA e-invoice output (`src/einvoicing/zatcaProvider.ts`) already builds a TLV QR; ensure the seller-name TLV tag carries the Arabic legal name as UTF-8 (ZATCA expects Arabic seller name). Add the Arabic invoice print layout (RTL) in the PDF/print path.
- Acceptance: an issued invoice's TLV/QR encodes the Arabic seller name (test the encoder); the invoice print renders RTL in AR mode.

**Commit(s):** `feat(i18n): Arabic locale`, `feat(ui): RTL layout`, `feat(invoice): Arabic seller name + RTL print`.

---

### PHASE 5 — Finish localization cleanup (remove all Colombian/Spanish residue)

**Objective:** zero Spanish/Colombian strings anywhere, including non-user-facing code, and honest naming.

- `src/index.ts`: translate the CLI demo output to English (or delete it if redundant with tests — check `package.json` `demo` script).
- `main.ts`: fix the startup banner ("en" → "at"); gate/English-ify the demo-login console print.
- Demo seed users (`src/api/auth.ts` `seedUsers`): rename to Saudi names/emails (e.g. an `@audita.sa` domain) — demo-only, keep behind the seed guard from 3.2.
- `src/api/pdf.ts`: replace the Spanish `es` label block with `ar` (Arabic), consistent with Phase 4.
- Rename Spanish JSON keys in `src/api/serialize.ts` / `src/domain/taxReport.ts` (`retencionesAFavor` → `withholdingReceivable`, `retencionesPorPagar` → `withholdingPayable`, etc.). **This is an API contract change** — update the UI (`public/index.html`) consumers and tests in lockstep.
- Rename money helpers `pesos`/`toPesosNumber`/`formatCOP` → `minor`/`toMajorNumber`/`formatSAR` (or similar) across the codebase with a single mechanical pass; update all imports and tests. Pure rename, no behavior change.
- Risk-band enum `alto/medio/bajo` → `high/medium/low`; update `bandColor` mapping in the UI and any tests.
- Acceptance: `grep -rInE 'Colombia|NIIF|DIAN|retenci|centavo|pesos|formatCOP|\balto\b|\bmedio\b|\bbajo\b|COP\b' src public` returns nothing meaningful (allow historical text in `README.md`/docs); 71+ tests green.

**Commit(s):** `refactor: purge Spanish/Colombian residue; SAR-native naming`.

---

### PHASE 6 — Test, CI, and observability hardening

**Objective:** production confidence.

- **Coverage:** add tests for the untested API surfaces touched above; add a property test for the ZATCA chain (ICV strictly increments, PIH of invoice N equals hash of invoice N-1, chain verifiable end-to-end).
- **CI:** ensure the workflow runs the migration runner (Phase 1.3), the full vitest suite, typecheck, and the pg smoke. Add `npm audit --production` (non-blocking report) and a build step.
- **Observability:** structured JSON request logging with a request id; a `/ready` endpoint that checks DB connectivity (distinct from `/health`); ensure no secrets are ever logged. Keep it dependency-light (a tiny logger, not a heavy framework).
- Acceptance: CI green on a clean checkout; `/ready` returns 200 only when the DB is reachable.

**Commit(s):** `test: chain + api coverage`, `chore(ci): migrations + audit`, `feat(ops): structured logging + readiness`.

---

## 5. Explicitly OUT OF SCOPE (gated — do not build, do not fake)

These need something only Jose can provide. Leave the existing clean seam and STOP:
- **Live ZATCA integration** (real clearance/reporting). Needs ZATCA onboarding + a CSID (cryptographic stamp identity) / an accredited solution provider. `ZatcaEInvoicingProvider` stays a local/simulated provider behind the `EInvoicingProvider` interface. Do not call any ZATCA endpoint.
- **Live bank feeds / aggregator.** No Saudi bank/aggregator credentials exist. Keep the paste-a-statement reconciliation; do not integrate a bank API.
- **Cloud deployment.** No hosting account/secrets. `docker-compose` (local prod-like) is the ceiling. Do not add Terraform/K8s/cloud-specific deploy config.
- Payroll, inventory/POS, multi-currency, a new frontend framework.

If a task seems blocked on one of these, it's done — note it and move on.

---

## 6. Definition of done for the whole plan

- App boots against Postgres via `docker compose up`, persists across restarts, with enforced tenant isolation.
- Every endpoint validates input and returns structured errors; multi-step operations are atomic.
- No demo credentials reachable in production; users persisted; token lifecycle enforced; authz + tenancy covered by tests.
- UI fully functional in Arabic with correct RTL; no Spanish anywhere in `src/` or `public/`.
- All five sacred invariants still hold; full test suite (existing 71 + new) green; typecheck clean; CI green.
- Each phase committed separately with clear messages.

**Start with Section 1 (confirm 71 green), then Phase 1. Report progress per phase.**
