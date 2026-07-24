# Deploying Audita

This is the guide to take Audita from the zip you have to a URL you (and an
accountant tester) can open. It is written to be honest about what is
production-ready and what is still demo scaffolding.

## What is production-ready vs. demo

**Ready:** the ledger core and all its invariants (tested), the immutable audit
trail, the controls/findings engine, reports, reconciliation, templates, the
close checklist, CSV export, the REST API, JWT auth with scrypt-hashed
passwords, role-based permissions, security headers, and login rate limiting.

**Still demo (do before real customers):**
- **Users are seeded in memory** (`src/api/auth.ts` → `seedUsers`). Move them to
  the database and add a real sign-up / invite flow.
- **Client books are seeded in memory** on boot. The Postgres layer (`pgRepo`,
  `schema.sql`) is verified (`npm run test:pg`) but the live app does not yet
  persist per-tenant to it — wiring `FirmWorkspace` to a tenant-scoped
  `PostgresRepository` is the next data-layer task.
- **DIAN e-invoicing is the sandbox adapter.** Swap in a certified proveedor
  tecnológico via `HttpPTProvider` + `.env` credentials (see `.env.example`).

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `AUDITA_JWT_SECRET` | **yes in prod** | Signs session tokens. The app refuses to boot in `NODE_ENV=production` with the dev default. Generate: `openssl rand -hex 32`. |
| `PORT` | no (default 3000) | HTTP port. |
| `NODE_ENV` | prod: `production` | Enables the secret guard. |
| `DATABASE_URL` | when PG wired | Postgres connection string. |
| `EINVOICE_*` | for live DIAN | Certified provider credentials (see `.env.example`). |

## Run it

### Local (development)
```bash
npm install
npm run api          # tsx, hot source — http://localhost:3000
```

### Local (production build)
```bash
npm run build        # tsc -> dist/
AUDITA_JWT_SECRET=$(openssl rand -hex 32) NODE_ENV=production npm start
```

### Docker
```bash
export AUDITA_JWT_SECRET=$(openssl rand -hex 32)
docker compose up --build      # app on :3000, Postgres on :5432
```

### A cloud host (Render / Fly.io / Railway)
All three build from the `Dockerfile` with zero changes:
- **Build:** the Dockerfile (multi-stage; no build command needed).
- **Start:** `node dist/api/main.js` (the image's default).
- **Env:** set `NODE_ENV=production` and `AUDITA_JWT_SECRET` (a strong random
  value). Add `DATABASE_URL` once persistence is wired.
- **Port:** the app listens on `PORT` (default 3000); set it to the platform's
  injected port if required.
- **HTTPS:** terminate TLS at the platform. The verification page uses
  `crypto.subtle`, which requires a secure context (HTTPS or localhost).

## Demo logins (password: `audita`)
`ana@audita.co` (partner) · `carlos@audita.co` (accountant) · `sofia@audita.co`
(staff) · `cliente@andina.co` (viewer). Remove these before real use.

## Push to GitHub
This folder is a git repo with an initial commit. To publish:
```bash
# create an empty repo on github.com first, then:
git remote add origin https://github.com/<you>/audita.git
git branch -M main
git push -u origin main
```
CI (`.github/workflows/ci.yml`) runs typecheck + the full test suite + the
Postgres integration smoke on every push.

## Security checklist before real customers
- [ ] Strong `AUDITA_JWT_SECRET` from a secret manager (not committed).
- [ ] Users and books persisted in Postgres; seed users removed.
- [ ] A strict Content-Security-Policy (the demo disables CSP because the UI is
      inline; move client JS/CSS to files with nonces).
- [ ] HTTPS enforced; secure, httpOnly cookie option considered over localStorage.
- [ ] Certified DIAN provider wired and tested in the DIAN habilitación set.
- [ ] Backups + point-in-time recovery on the database (a compliance control).
