/**
 * REST API over the audit-first core. Express, thin: it validates input, calls
 * the domain services, and serializes at the edge. Auth is an API key; every
 * request is scoped to a client (tenant) whose books are structurally isolated
 * in the FirmWorkspace.
 *
 * Run: `npm run api`  (PORT, AUDITA_API_KEY from env)
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirmWorkspace } from '../services/firmWorkspace.js';
import { pesos } from '../domain/money.js';
import { serializeEntry, serializeReports } from './serialize.js';
import { assembleClosePackage, buildWorkingPaper } from '../domain/workingPapers.js';
import { naturalBalance, accountProvenance, trialBalance } from '../domain/reports.js';
import { CHART_OF_ACCOUNTS, ACCT, CASH_AND_BANK, getAccount, accountExists } from '../domain/accounts.js';
import { toPesosNumber } from '../domain/money.js';
import { randomUUID } from 'node:crypto';
import { benfordAnalysis, velocityAnalysis } from '../domain/controls/analysis.js';
import { isOpen, type FindingStatus } from '../domain/findings.js';
import { reconcile, parseStatement, type StatementLine } from '../domain/reconcile.js';
import { normalizeLines } from '../domain/journal.js';
import { buildChecklist } from '../domain/closeChecklist.js';
import { aging, outstanding, isOpen as itemOpen, type OpenItem, type Contact } from '../domain/subledger.js';
import { applyRateBps } from '../domain/money.js';
import { streamStatementsPdf } from './pdf.js';
import {
  UserStore, authMiddleware, requireRole, signToken, verifyPassword,
  type AuthedRequest,
} from './auth.js';
import { Collection, flushWrites, storageMode, storageDescription } from '../persistence/store.js';
import type { ClientMeta } from '../services/firmWorkspace.js';
import { GCC, gccCountry, type GccCountry } from '../domain/gcc.js';
import { vatReport } from '../domain/vatReport.js';
import { vatRules, TREATMENTS } from '../domain/vatTreatment.js';
import { incomeStatement, balanceSheet, cashFlowStatement } from '../domain/reports.js';
import { locksCollection } from './locks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(firm: FirmWorkspace, users: UserStore, clientStore?: Collection<ClientMeta>) {
  const app = express();
  // Security headers (HSTS, X-Content-Type-Options, frameguard, etc.). CSP is
  // disabled because the demo UI is inline; a strict CSP with nonces is the
  // follow-up when the client JS/CSS move to external files.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(authMiddleware(users));

  // Durable-write barrier. Mutating handlers write through an in-memory cache
  // and let the durable copy land in the background (see persistence/store.ts).
  // On a long-running server that is invisible; on serverless the instance can
  // be frozen the instant the response flushes, so we hold the response until
  // the durable write has actually landed — and fail the request if it didn't.
  // A 201 that isn't backed by a stored row is the worst failure this app can
  // have, given the whole product is an immutable audit trail.
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const sendJson = res.json.bind(res);
    let barriered = false;
    res.json = ((body: unknown) => {
      if (barriered) return sendJson(body);
      barriered = true;
      flushWrites().then(
        () => sendJson(body),
        (err: unknown) => {
          console.error('[api] refusing to confirm a write that did not persist:', err);
          if (!res.headersSent) res.status(500);
          sendJson({
            error: 'Your change could not be saved durably, so it has not been '
              + 'confirmed. Nothing was reported as posted. Retry, and if this '
              + 'repeats, the database is unreachable.',
            storage: storageMode(),
          });
        },
      );
      return res;
    }) as typeof res.json;
    next();
  });

  const locksCol = locksCollection();

  app.get('/health', (_req, res) => {
    const mode = storageMode();
    // A host health check must FAIL when storage is configured but unreachable,
    // so a broken deploy is rolled back instead of accepting data it cannot keep.
    const ok = mode !== 'unavailable';
    res.status(ok ? 200 : 503).json({
      ok,
      service: 'audita',
      version: '0.6.0-ksa',
      storage: mode,
      durable: mode === 'postgres' || mode === 'disk',
      storageNote: storageDescription(),
    });
  });

  // ---- Auth ----
  // Brute-force protection: cap login attempts per IP.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Please try again later.' },
  });
  app.post('/api/auth/login', loginLimiter, (req, res) => {
    const { email, password } = req.body ?? {};
    const user = email ? users.find(String(email)) : undefined;
    if (!user || !verifyPassword(String(password ?? ''), user.passwordHash)) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    const token = signToken({ sub: user.id, email: user.email, name: user.name, role: user.role, firmId: user.firmId });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  });

  app.get('/api/me', (req: AuthedRequest, res) => res.json(req.user));

  // Chart of accounts (for the entry form).
  app.get('/api/accounts', (_req, res) => {
    res.json(CHART_OF_ACCOUNTS.map((a) => ({ code: a.code, name: a.name, nameAr: a.nameAr, type: a.type, normal: a.normal })));
  });

  // GCC country catalogue + editable rate overrides (a firm can adjust a rate
  // if a country changes it, without a code change). Overrides persist.
  const taxOverrides = new Collection<{ vatBps?: number; corpTaxPct?: number; zakatPct?: number | null }>('tax-overrides.json');
  const resolveCountry = (id?: string): GccCountry => {
    const base = gccCountry(id);
    const o = taxOverrides.get(base.id);
    if (!o) return base;
    return {
      ...base,
      vatBps: o.vatBps ?? base.vatBps,
      corpTaxPct: o.corpTaxPct ?? base.corpTaxPct,
      zakatPct: o.zakatPct === undefined ? base.zakatPct : o.zakatPct,
    };
  };
  app.get('/api/gcc', (_req, res) => res.json(GCC.map((c) => resolveCountry(c.id))));
  // Edit the tax rates for a country (partner only). Body: {vatBps?, corpTaxPct?, zakatPct?}
  app.post('/api/gcc/:id', requireRole('partner'), (req, res) => {
    const base = GCC.find((c) => c.id === String(req.params.id).toUpperCase());
    if (!base) return res.status(404).json({ error: 'Unknown country.' });
    const b = req.body ?? {};
    taxOverrides.set(base.id, {
      vatBps: b.vatBps != null ? Math.round(Number(b.vatBps)) : undefined,
      corpTaxPct: b.corpTaxPct != null ? Number(b.corpTaxPct) : undefined,
      zakatPct: b.zakatPct === '' || b.zakatPct === null ? null : b.zakatPct != null ? Number(b.zakatPct) : undefined,
    });
    res.json(resolveCountry(base.id));
  });
  // Change a client's country (accountant+). Switches its currency, VAT and compliance.
  app.post('/api/clients/:id/country', requireRole('accountant'), (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const country = gccCountry(req.body?.country).id;
    c.meta.country = country;
    clientStore?.set(c.meta.clientId, { ...c.meta });
    res.json({ clientId: c.meta.clientId, country });
  });

  // --- Firm console: all clients ranked by risk ---
  app.get('/api/clients', async (_req, res) => {
    res.json(await firm.console());
  });

  app.post('/api/clients', requireRole('accountant'), (req, res) => {
    const { clientId, name, ofeNit, country } = req.body ?? {};
    if (!clientId || !name || !ofeNit) {
      return res.status(400).json({ error: 'clientId, name and tax ID are required.' });
    }
    try {
      const meta: ClientMeta = { clientId, name, ofeNit, country: gccCountry(country).id };
      firm.addClient(meta);
      clientStore?.set(String(clientId), meta);
      res.status(201).json(meta);
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  // helper to resolve a client or 404
  const withClient = (req: Request, res: Response) => {
    try {
      return firm.client(String(req.params.id));
    } catch {
      res.status(404).json({ error: `Client not found: ${req.params.id}` });
      return null;
    }
  };

  app.get('/api/clients/:id/entries', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    res.json((await c.repo.listEntries()).map(serializeEntry));
  });

  app.post('/api/clients/:id/entries', requireRole('staff'), async (req: AuthedRequest, res) => {
    const c = withClient(req, res); if (!c) return;
    const { date, memo, source, lines, docDate, sourceDocument } = req.body ?? {};
    if (!Array.isArray(lines)) return res.status(400).json({ error: 'At least one line is required.' });
    // Validate BEFORE anything is persisted. A journal entry is immutable and
    // hash-chained, so a request that is missing a required field must be
    // rejected here — not halfway through posting, where the entry is already
    // in the chain and the caller has been told it failed.
    const sDate = typeof date === 'string' ? date.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sDate)) {
      return res.status(400).json({ error: 'A posting date in YYYY-MM-DD format is required.' });
    }
    const sMemo = typeof memo === 'string' ? memo.trim() : '';
    if (!sMemo) return res.status(400).json({ error: 'A description (memo) is required.' });
    const sSource = typeof source === 'string' && source.trim() ? source.trim() : 'Manual entry';
    try {
      const draftLines = lines.map((l: { accountCode: string; debit?: number; credit?: number }) => ({
        accountCode: l.accountCode,
        debit: l.debit ? pesos(l.debit) : undefined,
        credit: l.credit ? pesos(l.credit) : undefined,
      }));
      const { entry, findings } = await c.ledger.post({
        date: sDate, memo: sMemo, source: sSource, user: req.user!.name, lines: draftLines,
        docDate: docDate ? String(docDate) : undefined,
        sourceDocument: sourceDocument ? String(sourceDocument) : undefined,
      });
      res.status(201).json({ entry: serializeEntry(entry), findings });
    } catch (e) {
      res.status(422).json({ error: (e as Error).message });
    }
  });

  app.post('/api/clients/:id/invoices', requireRole('staff'), async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const { client, acquirerId, date, concept, base, reteIcaBps, reteIvaBps } = req.body ?? {};
    if (!client || !base) return res.status(400).json({ error: 'Customer name and net amount are required.' });
    try {
      const inv = await c.invoices.issue({
        client, acquirerId: acquirerId ?? '222222', date, concept: concept ?? 'Sale',
        base: pesos(Number(base)), ofeNit: c.meta.ofeNit,
        vatBps: resolveCountry(c.meta.country).vatBps,
        reteIcaBps: Number(reteIcaBps) || 0, reteIvaBps: Number(reteIvaBps) || 0,
      });
      // open a receivable so the customer's balance is tracked and ages
      addReceivable(c.meta.clientId, {
        contactId: String(acquirerId ?? ''), contactName: String(client), docNumber: inv.number,
        date: String(date), dueDate: addDays(String(date), 30), original: inv.total, entryId: inv.entryId,
      });
      res.status(201).json({
        number: inv.number, cufe: inv.cufe, status: inv.status,
        base: Number(base), total: toPesosNumber(inv.total), entryId: inv.entryId,
        reteFuente: toPesosNumber(inv.rete), reteIca: toPesosNumber(inv.reteIca), reteIva: toPesosNumber(inv.reteIva),
      });
    } catch (e) {
      res.status(422).json({ error: (e as Error).message });
    }
  });

  app.get('/api/clients/:id/findings', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    res.json(await c.repo.listFindings());
  });

  app.post('/api/clients/:id/findings/:fid/status', requireRole('accountant'), async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const status = req.body?.status as FindingStatus;
    if (!['open', 'reviewed', 'cleared', 'escalated'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }
    try {
      await c.ledger.setFindingStatus(String(req.params.fid), status, req.body?.note);
      res.json({ ok: true });
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  app.get('/api/clients/:id/reports', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    res.json(serializeReports(await c.repo.listEntries()));
  });

  app.get('/api/clients/:id/audit', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const trail = c.ledger.auditTrail();
    res.json({ events: trail.all(), verification: trail.verify() });
  });

  app.get('/api/clients/:id/analytics', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const entries = await c.repo.listEntries();
    res.json({ benford: benfordAnalysis(entries), velocity: velocityAnalysis(entries) });
  });

  app.get('/api/clients/:id/close', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const period = (req.query.period as string) ?? '2026-06';
    const entries = await c.repo.listEntries();
    const findings = await c.repo.listFindings();
    const trail = c.ledger.auditTrail();
    const { trialBalance } = await import('../domain/reports.js');
    const tb = trialBalance(entries);
    // one demo working paper on bank, tied to book balance
    const wp = buildWorkingPaper({
      id: 'WP-1010', accountCode: '1010', period, entries,
      supportBalance: naturalBalance('1010', entries), preparedBy: 'api', createdAt: new Date().toISOString(),
    });
    const pkg = assembleClosePackage({
      period, generatedAt: new Date().toISOString(),
      trialBalanceBalanced: tb.balanced, auditTrailValid: trail.verify().valid,
      openHighFindings: findings.filter((f) => f.severity === 'high' && isOpen(f)).length,
      openFindings: findings.filter((f) => f.status === 'open').length,
      workingPapers: [wp],
    });
    res.json({ ...pkg, workingPapers: pkg.workingPapers.map((w) => ({ ...w, bookedBalance: undefined, supportBalance: undefined, difference: Number(w.difference) })) });
  });

  // ---- "Prove this number": provenance of an account balance ----
  app.get('/api/clients/:id/provenance/:code', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    try {
      const p = accountProvenance(String(req.params.code), await c.repo.listEntries());
      const audit = await c.repo.listAudit();
      res.json({
        code: p.code,
        name: p.name,
        natural: toPesosNumber(p.natural),
        lines: p.lines.map((l) => ({
          entryId: l.entryId,
          date: l.date,
          memo: l.memo,
          source: l.source,
          reversed: l.reversed,
          debit: toPesosNumber(l.debit),
          credit: toPesosNumber(l.credit),
          contribution: toPesosNumber(l.contribution),
          hash: audit.find((a) => a.ref === l.entryId && a.action === 'POST_ENTRY')?.hash ?? null,
        })),
      });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // ---- Working papers (native assurance workflow) ----
  app.get('/api/clients/:id/working-papers', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const wps = await c.repo.listWorkingPapers();
    res.json(wps.map((w) => ({
      id: w.id, accountCode: w.accountCode, period: w.period, status: w.status,
      bookedBalance: toPesosNumber(w.bookedBalance), supportBalance: toPesosNumber(w.supportBalance),
      difference: toPesosNumber(w.difference), notes: w.notes, preparedBy: w.preparedBy ?? null,
    })));
  });

  app.post('/api/clients/:id/working-papers', requireRole('staff'), async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const { accountCode, period, supportBalance, notes } = req.body ?? {};
    if (!accountCode || !period || supportBalance === undefined) {
      return res.status(400).json({ error: 'Account, period and supporting balance are all required.' });
    }
    try {
      const entries = await c.repo.listEntries();
      const wp = buildWorkingPaper({
        id: `WP-${accountCode}-${period}`, accountCode, period, entries,
        supportBalance: pesos(Number(supportBalance)), preparedBy: 'api', notes,
        createdAt: new Date().toISOString(),
      });
      await c.repo.saveWorkingPaper(wp);
      const ev = c.ledger.auditTrail().append({
        action: 'WORKING_PAPER', ref: wp.id,
        detail: { accountCode, period, tied: wp.difference === 0n }, user: 'api', ts: wp.createdAt,
      });
      await c.repo.appendAudit(ev);
      res.status(201).json({
        id: wp.id, accountCode: wp.accountCode, period: wp.period, status: wp.status,
        bookedBalance: toPesosNumber(wp.bookedBalance), supportBalance: toPesosNumber(wp.supportBalance),
        difference: toPesosNumber(wp.difference), notes: wp.notes,
      });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // ---- Verifiable third-party sharing ----
  // A firm creates a share token; anyone with the link can INDEPENDENTLY verify
  // the books in their own browser — no API key, no trusting this server.
  const shares = new Map<string, string>(); // token -> clientId
  app.post('/api/clients/:id/share', requireRole('accountant'), async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const token = randomUUID();
    shares.set(token, c.meta.clientId);
    res.status(201).json({ token, url: `/verify.html?t=${token}` });
  });

  app.get('/api/verify/:token', async (req, res) => {
    const clientId = shares.get(String(req.params.token));
    if (!clientId) return res.status(404).json({ error: 'Verification link is invalid or has expired.' });
    const c = firm.client(clientId);
    const entries = await c.repo.listEntries();
    const events = await c.repo.listAudit();
    const tb = trialBalance(entries);
    res.json({
      firm: 'Audita',
      client: c.meta.name,
      generatedFields: {
        trialBalanceBalanced: tb.balanced,
        totalDebit: toPesosNumber(tb.totalDebit),
        totalCredit: toPesosNumber(tb.totalCredit),
        entryCount: entries.length,
      },
      // Head of the hash chain = the books' fingerprint.
      seal: events.length ? events[events.length - 1]!.hash : null,
      // Everything needed to re-verify INDEPENDENTLY in the recipient's browser:
      auditEvents: events.map((e) => ({
        seq: e.seq, action: e.action, ref: e.ref, detail: e.detail,
        user: e.user, ts: e.ts, prevHash: e.prevHash, hash: e.hash,
      })),
      entries: entries.map((e) => ({
        id: e.id,
        lines: e.lines.map((l) => ({ debit: toPesosNumber(l.debit), credit: toPesosNumber(l.credit) })),
      })),
    });
  });

  // ---- Bank reconciliation ----
  app.post('/api/clients/:id/reconcile', requireRole('staff'), async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const { statement, csv } = req.body ?? {};
    let lines: StatementLine[];
    if (typeof csv === 'string') lines = parseStatement(csv, pesos);
    else if (Array.isArray(statement)) {
      lines = statement.map((s: { date: string; description: string; amount: number }) =>
        ({ date: s.date, description: s.description, amount: pesos(Number(s.amount)) }));
    } else return res.status(400).json({ error: 'Send either statement[] or csv text.' });
    const r = reconcile(lines, await c.repo.listEntries());
    res.json({
      matchedCount: r.matchedCount,
      statementCount: r.statementCount,
      matches: r.matches.map((m) => ({ date: m.statement.date, description: m.statement.description, amount: toPesosNumber(m.statement.amount), entryId: m.entryId, entryMemo: m.entryMemo })),
      unmatchedStatement: r.unmatchedStatement.map((s) => ({ date: s.date, description: s.description, amount: toPesosNumber(s.amount) })),
      unmatchedLedger: r.unmatchedLedger.map((u) => ({ entryId: u.entryId, date: u.date, memo: u.memo, delta: toPesosNumber(u.delta) })),
    });
  });

  // ---- Maker-checker review sign-off (segregation of duties) ----
  app.post('/api/clients/:id/entries/:eid/review', requireRole('accountant'), async (req: AuthedRequest, res) => {
    const c = withClient(req, res); if (!c) return;
    const eid = String(req.params.eid);
    const entries = await c.repo.listEntries();
    const entry = entries.find((e) => e.id === eid);
    if (!entry) return res.status(404).json({ error: 'Entry not found.' });
    if (entry.user === req.user!.name) {
      return res.status(422).json({ error: 'You cannot review your own entry — segregation of duties requires a different reviewer.' });
    }
    const ev = c.ledger.auditTrail().append({
      action: 'ENTRY_REVIEWED', ref: eid,
      detail: { reviewer: req.user!.name, role: req.user!.role }, user: req.user!.name, ts: new Date().toISOString(),
    });
    await c.repo.appendAudit(ev);
    res.json({ ok: true, reviewer: req.user!.name });
  });

  // ---- CSV exports (get your data out — to Excel / Sheets / tax software) ----
  // One quoting rule for every export: anything that could contain a comma,
  // a quote or a newline is quoted and its quotes doubled. Excel and Sheets
  // both read this without a dialog.
  const csvCell = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return '';
    const t = String(v);
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const csvBody = (rows: (string | number | null | undefined)[][]): string =>
    rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const sendCsv = (res: Response, filename: string, rows: (string | number | null | undefined)[][]) => {
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${filename}"`);
    // BOM so Excel opens UTF-8 (Arabic account names) correctly.
    res.send('\uFEFF' + csvBody(rows));
  };

  app.get('/api/clients/:id/export/trial-balance.csv', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const tb = trialBalance(await c.repo.listEntries());
    sendCsv(res, 'trial-balance.csv', [
      ['code', 'account', 'debit', 'credit'],
      ...tb.rows.map((r) => [r.code, r.name, toPesosNumber(r.debit), toPesosNumber(r.credit)]),
      ['', 'TOTAL', toPesosNumber(tb.totalDebit), toPesosNumber(tb.totalCredit)],
    ]);
  });

  app.get('/api/clients/:id/export/journal.csv', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const entries = await c.repo.listEntries();
    const rows: (string | number | null)[][] = [[
      'entry', 'posting_date', 'document_date', 'document_no', 'account', 'account_name',
      'debit', 'credit', 'memo', 'counterparty', 'user', 'reversed',
    ]];
    for (const e of entries) {
      for (const l of e.lines) {
        // account_name used to print the code — a real name is what makes the
        // export usable in Excel without a lookup table.
        const name = accountExists(l.accountCode) ? getAccount(l.accountCode).name : '(unmapped)';
        rows.push([e.id, e.date, e.docDate ?? '', e.sourceDocument ?? '', l.accountCode, name,
          toPesosNumber(l.debit), toPesosNumber(l.credit), e.memo, e.source, e.user, e.reversed ? 'yes' : '']);
      }
    }
    sendCsv(res, 'journal.csv', rows);
  });

  // ---- Recurring journal templates (one-click monthly postings) ----
  interface RecurringTemplate {
    id: string; name: string; memo: string; source: string;
    lines: { accountCode: string; debit: number; credit: number }[];
  }
  const templates = new Map<string, Map<string, RecurringTemplate>>(); // clientId -> tid -> template
  let tSeq = 0;
  const clientTemplates = (id: string) => {
    if (!templates.has(id)) templates.set(id, new Map());
    return templates.get(id)!;
  };

  app.get('/api/clients/:id/templates', (req, res) => {
    const c = withClient(req, res); if (!c) return;
    res.json([...clientTemplates(c.meta.clientId).values()]);
  });

  app.post('/api/clients/:id/templates', requireRole('staff'), (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const { name, memo, source, lines } = req.body ?? {};
    if (!name || !Array.isArray(lines)) return res.status(400).json({ error: 'A template name and at least one line are required.' });
    try {
      // A template must itself balance, so posting it can never unbalance the books.
      normalizeLines(lines.map((l: { accountCode: string; debit?: number; credit?: number }) => ({
        accountCode: l.accountCode, debit: l.debit ? pesos(Number(l.debit)) : undefined, credit: l.credit ? pesos(Number(l.credit)) : undefined,
      })));
    } catch (e) {
      return res.status(422).json({ error: (e as Error).message });
    }
    tSeq += 1;
    const tpl: RecurringTemplate = {
      id: `T-${tSeq}`, name: String(name), memo: String(memo ?? name), source: String(source ?? ''),
      lines: lines.map((l: { accountCode: string; debit?: number; credit?: number }) =>
        ({ accountCode: l.accountCode, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 })),
    };
    clientTemplates(c.meta.clientId).set(tpl.id, tpl);
    res.status(201).json(tpl);
  });

  app.post('/api/clients/:id/templates/:tid/post', requireRole('staff'), async (req: AuthedRequest, res) => {
    const c = withClient(req, res); if (!c) return;
    const tpl = clientTemplates(c.meta.clientId).get(String(req.params.tid));
    if (!tpl) return res.status(404).json({ error: 'Plantilla no encontrada.' });
    const date = String(req.body?.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) requerida.' });
    try {
      const { entry, findings } = await c.ledger.post({
        date, memo: tpl.memo, source: tpl.source || 'Recurrente', user: req.user!.name,
        lines: tpl.lines.map((l) => ({ accountCode: l.accountCode, debit: l.debit ? pesos(l.debit) : undefined, credit: l.credit ? pesos(l.credit) : undefined })),
      });
      res.status(201).json({ entry: serializeEntry(entry), findings });
    } catch (e) {
      res.status(422).json({ error: (e as Error).message });
    }
  });

  app.delete('/api/clients/:id/templates/:tid', requireRole('staff'), (req, res) => {
    const c = withClient(req, res); if (!c) return;
    clientTemplates(c.meta.clientId).delete(String(req.params.tid));
    res.json({ ok: true });
  });

  // ---- Period-close checklist (the monthly ritual, with sign-off) ----
  const checklistStore = new Map<string, Record<string, { done: boolean; by?: string; at?: string }>>();
  const clKey = (id: string, period: string) => `${id}:${period}`;

  async function autoState(c: NonNullable<ReturnType<typeof firm.client>>) {
    const [entries, findings, wps] = await Promise.all([c.repo.listEntries(), c.repo.listFindings(), c.repo.listWorkingPapers()]);
    return {
      trialBalanceBalanced: trialBalance(entries).balanced,
      openHighFindings: findings.filter((f) => f.severity === 'high' && isOpen(f)).length,
      workingPapersUntied: wps.filter((w) => w.difference !== 0n).length,
    };
  }

  app.get('/api/clients/:id/checklist', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const period = String(req.query.period ?? '2026-06');
    const stored = checklistStore.get(clKey(c.meta.clientId, period)) ?? {};
    res.json({ period, ...buildChecklist(stored, await autoState(c)) });
  });

  app.post('/api/clients/:id/checklist/:key', requireRole('staff'), async (req: AuthedRequest, res) => {
    const c = withClient(req, res); if (!c) return;
    const key = String(req.params.key);
    const period = String(req.body?.period ?? '2026-06');
    const done = !!req.body?.done;
    const k = clKey(c.meta.clientId, period);
    const state = checklistStore.get(k) ?? {};
    state[key] = { done, by: req.user!.name, at: new Date().toISOString() };
    checklistStore.set(k, state);
    const ev = c.ledger.auditTrail().append({
      action: 'CHECKLIST_SIGNOFF', ref: `${period}:${key}`,
      detail: { done, by: req.user!.name }, user: req.user!.name, ts: new Date().toISOString(),
    });
    await c.repo.appendAudit(ev);
    res.json({ ok: true });
  });

  // ---- Opening balances (migration) ----
  // Load a migrated trial balance as a single opening entry. Must balance.
  app.post('/api/clients/:id/opening-balances', requireRole('accountant'), async (req: AuthedRequest, res) => {
    const c = withClient(req, res); if (!c) return;
    const { date, lines } = req.body ?? {};
    if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'At least one line is required.' });
    try {
      const draftLines = lines.map((l: { accountCode: string; debit?: number; credit?: number }) => ({
        accountCode: l.accountCode,
        debit: l.debit ? pesos(Number(l.debit)) : undefined,
        credit: l.credit ? pesos(Number(l.credit)) : undefined,
      }));
      const { entry } = await c.ledger.post({
        date: String(date), memo: 'Saldos de apertura (migración)', source: 'Apertura', user: req.user!.name, lines: draftLines,
      });
      res.status(201).json({ entryId: entry.id });
    } catch (e) {
      res.status(422).json({ error: (e as Error).message });
    }
  });

  // ---- GCC compliance profile (country tax posture + Zakat / corporate-tax estimates) ----
  app.get('/api/clients/:id/compliance', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const country = resolveCountry(c.meta.country);
    const rep = serializeReports(await c.repo.listEntries());
    const equity = rep.balanceSheet.patrimonio;
    const profit = rep.incomeStatement.utilidad;
    const zakatBase = Math.max(0, equity);
    res.json({
      country,
      vat: { rateBps: country.vatBps, payable: rep.taxPosition.ivaAPagar },
      corpTax: { pct: country.corpTaxPct, profit, estimate: Math.max(0, Math.round(profit * country.corpTaxPct / 100)) },
      zakat: country.zakatPct === null ? null
        : { pct: country.zakatPct, base: zakatBase, amount: Math.round(zakatBase * country.zakatPct / 100) },
    });
  });

  // ---- Financial statements as NIIF PDF (integrity-stamped) ----
  app.get('/api/clients/:id/statements.pdf', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const lang = req.query.lang === 'en' ? 'en' : 'es';
    const period = String(req.query.period ?? '2026-06');
    const entries = await c.repo.listEntries();
    const events = c.ledger.auditTrail().all();
    const seal = events.length ? events[events.length - 1]!.hash : null;
    streamStatementsPdf(res, entries, { clientName: c.meta.name, ofeNit: c.meta.ofeNit, period, lang, seal }, new Date().toISOString());
  });

  // ---- Period lock (close control) ----
  app.get('/api/clients/:id/periods', (req, res) => {
    const c = withClient(req, res); if (!c) return;
    res.json({ locked: c.ledger.lockedPeriods() });
  });
  app.post('/api/clients/:id/periods/:period/lock', requireRole('partner'), async (req: AuthedRequest, res) => {
    const c = withClient(req, res); if (!c) return;
    const period = String(req.params.period);
    c.ledger.lockPeriod(period);
    // Persist the lock. Held only in memory it would silently reopen on the next
    // restart or cold start, which for a closed period is an audit failure, not
    // an inconvenience.
    locksCol.set(c.meta.clientId, { clientId: c.meta.clientId, periods: c.ledger.lockedPeriods() });
    const ev = c.ledger.auditTrail().append({
      action: 'PERIOD_CLOSE', ref: period, detail: { by: req.user!.name, locked: true }, user: req.user!.name, ts: new Date().toISOString(),
    });
    await c.repo.appendAudit(ev);
    res.json({ ok: true, locked: c.ledger.lockedPeriods() });
  });
  app.post('/api/clients/:id/periods/:period/unlock', requireRole('partner'), async (req: AuthedRequest, res) => {
    const c = withClient(req, res); if (!c) return;
    const period = String(req.params.period);
    c.ledger.unlockPeriod(period);
    locksCol.set(c.meta.clientId, { clientId: c.meta.clientId, periods: c.ledger.lockedPeriods() });
    const ev = c.ledger.auditTrail().append({
      action: 'PERIOD_CLOSE', ref: period, detail: { by: req.user!.name, locked: false }, user: req.user!.name, ts: new Date().toISOString(),
    });
    await c.repo.appendAudit(ev);
    res.json({ ok: true, locked: c.ledger.lockedPeriods() });
  });

  // ---- AR/AP subledger: contacts, bills, payments, aging ----
  // Contacts (customers / vendors) — durable across restarts.
  const contactsCol = new Collection<Contact & { clientId: string }>('contacts.json');
  const contactsList = (cid: string): Contact[] =>
    contactsCol.values().filter((x) => x.clientId === cid).map(({ clientId, ...r }) => { void clientId; return r; });
  const openItemsStore = new Map<string, Map<string, OpenItem>>(); // clientId -> id -> item
  let itemSeq = 0; let billSeq = 0;
  const itemsOf = (id: string) => { if (!openItemsStore.has(id)) openItemsStore.set(id, new Map()); return openItemsStore.get(id)!; };
  const addDays = (date: string, n: number) => {
    const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const serItem = (i: OpenItem) => ({
    id: i.id, kind: i.kind, contactName: i.contactName, docNumber: i.docNumber, date: i.date, dueDate: i.dueDate,
    original: toPesosNumber(i.original), paid: toPesosNumber(i.paid), outstanding: toPesosNumber(outstanding(i)), entryId: i.entryId,
  });

  // expose the subledger so the invoice endpoint can create receivables
  const addReceivable = (clientId: string, r: Omit<OpenItem, 'id' | 'kind' | 'paid'>) => {
    itemSeq += 1;
    const item: OpenItem = { ...r, id: `OI-${itemSeq}`, kind: 'receivable', paid: 0n };
    itemsOf(clientId).set(item.id, item);
    return item;
  };

  app.get('/api/clients/:id/contacts', (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const kind = req.query.kind as string | undefined;
    let list = contactsList(c.meta.clientId);
    if (kind === 'customer' || kind === 'vendor') list = list.filter((x) => x.kind === kind || x.kind === 'both');
    res.json(list);
  });
  app.post('/api/clients/:id/contacts', requireRole('staff'), (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const { name, nit, kind, phone, email, bank } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'A name is required.' });
    const k: Contact['kind'] = kind === 'customer' || kind === 'vendor' ? kind : 'both';
    const id = `CT-${randomUUID().slice(0, 8)}`;
    const contact: Contact & { clientId: string } = {
      id, clientId: c.meta.clientId, name: String(name), nit: String(nit ?? ''), kind: k,
      phone: phone ? String(phone) : undefined,
      email: email ? String(email) : undefined,
      bank: bank ? String(bank) : undefined,
    };
    contactsCol.set(`${c.meta.clientId}:${id}`, contact);
    const { clientId: _cid, ...pub } = contact; void _cid;
    res.status(201).json(pub);
  });

  // ---- Inventory / Products — durable catalog with stock ----
  interface Product { id: string; clientId: string; sku: string; name: string; nameAr?: string; unit: string; price: number; cost: number; stock: number; }
  const productsCol = new Collection<Product>('products.json');
  const productsList = (cid: string) => productsCol.values().filter((p) => p.clientId === cid)
    .map(({ clientId, ...r }) => { void clientId; return r; });
  if (productsCol.values().length === 0) {
    const demo: [string, string, string, string, string, number, number, number][] = [
      ['andina', 'AL-1050', 'Aluminum sheet 1050', 'صفيحة ألمنيوم', 'sheet', 340, 210, 120],
      ['andina', 'FLT-22', 'Hydraulic filter FLT-22', 'مرشح هيدروليكي', 'unit', 890, 540, 36],
      ['andina', 'BRG-6204', 'Bearing 6204-2RS', 'محمل كروي', 'unit', 45, 22, 480],
      ['roble', 'RICE-25', 'Basmati rice 25kg', 'أرز بسمتي', 'bag', 128, 92, 210],
    ];
    for (const [cid, sku, name, nameAr, unit, price, cost, stock] of demo) {
      const id = `P-${sku}`;
      productsCol.set(`${cid}:${id}`, { id, clientId: cid, sku, name, nameAr, unit, price, cost, stock });
    }
  }
  app.get('/api/clients/:id/products', (req, res) => {
    const c = withClient(req, res); if (!c) return;
    res.json(productsList(c.meta.clientId));
  });
  app.post('/api/clients/:id/products', requireRole('staff'), (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const { sku, name, nameAr, unit, price, cost, stock } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name is required.' });
    const id = `P-${randomUUID().slice(0, 8)}`;
    const prod: Product = {
      id, clientId: c.meta.clientId, sku: String(sku ?? ''), name: String(name),
      nameAr: nameAr ? String(nameAr) : undefined, unit: String(unit ?? 'unit'),
      price: Number(price) || 0, cost: Number(cost) || 0, stock: Number(stock) || 0,
    };
    productsCol.set(`${c.meta.clientId}:${id}`, prod);
    const { clientId, ...rest } = prod; void clientId;
    res.status(201).json(rest);
  });
  app.post('/api/clients/:id/products/:pid/stock', requireRole('staff'), (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const key = `${c.meta.clientId}:${String(req.params.pid)}`;
    const prod = productsCol.get(key);
    if (!prod) return res.status(404).json({ error: 'Product not found.' });
    prod.stock += Number(req.body?.delta) || 0;
    productsCol.set(key, prod);
    const { clientId, ...rest } = prod; void clientId;
    res.json(rest);
  });

  // Vendor bill: books Dr expense + Dr input VAT, Cr withholding, Cr accounts payable;
  // opens a payable in the subledger. Shared by the one-off bill endpoint and by
  // recurring bills, so a recurring phone bill posts exactly the same way a
  // hand-keyed one does — same journal entry, same audit trail, same payable.
  type BillInput = {
    vendorName: string; vendorNit?: string; date: string; base: number;
    expenseAccount?: string; dueDays?: number; vatTreatment?: string; memo?: string;
  };
  async function postBill(
    c: NonNullable<ReturnType<typeof withClient>>,
    user: string,
    input: BillInput,
  ) {
    const baseM = pesos(Number(input.base) || 0);
    if (!input.vendorName || baseM <= 0n) {
      throw new Error('Vendor name and a net amount greater than zero are required.');
    }
    const acct = String(input.expenseAccount || '6000');
    const country = resolveCountry(c.meta.country);
    // Treatment drives the rate: standard takes the jurisdiction rate, zero-rated
    // and exempt take 0%. Exempt also means the input VAT would not be
    // recoverable, so none is booked at all.
    const treatment = input.vatTreatment && ['standard', 'zero_rated', 'exempt', 'out_of_scope', 'reverse_charge'].includes(input.vatTreatment)
      ? input.vatTreatment : 'standard';
    const rateBps = treatment === 'standard' || treatment === 'reverse_charge' ? country.vatBps : 0;
    const iva = applyRateBps(baseM, rateBps);
    billSeq += 1;
    const number = `FC-${String(billSeq).padStart(4, '0')}`;
    // Reverse charge: the buyer books BOTH sides — output VAT it owes and the
    // matching input VAT it reclaims — so the payable to the vendor is net only.
    const reverse = treatment === 'reverse_charge';
    const payable = reverse ? baseM : baseM + iva;
    const { entry, findings } = await c.ledger.post({
      date: String(input.date),
      memo: input.memo ? String(input.memo) : `Purchase invoice ${number} — ${input.vendorName}`,
      source: String(input.vendorName), user,
      sourceDocument: number,
      lines: [
        { accountCode: acct, debit: baseM },
        ...(iva > 0n ? [{ accountCode: '1150', debit: iva }] : []),
        ...(reverse && iva > 0n ? [{ accountCode: '2100', credit: iva }] : []),
        { accountCode: '2000', credit: payable },
      ],
    });
    itemSeq += 1;
    const item: OpenItem = {
      id: `OI-${itemSeq}`, kind: 'payable', contactId: String(input.vendorNit ?? ''), contactName: String(input.vendorName),
      docNumber: number, date: String(input.date), dueDate: addDays(String(input.date), Number(input.dueDays) || 30),
      original: payable, paid: 0n, entryId: entry.id,
    };
    itemsOf(c.meta.clientId).set(item.id, item);
    return {
      bill: { number, entryId: entry.id, base: toPesosNumber(baseM), vat: toPesosNumber(iva), payable: toPesosNumber(payable), vatTreatment: treatment },
      item: serItem(item), findings,
    };
  }

  app.post('/api/clients/:id/bills', requireRole('staff'), async (req: AuthedRequest, res) => {
    const c = withClient(req, res); if (!c) return;
    const { vendorName, vendorNit, date, base, expenseAccount, dueDays, vatTreatment, memo } = req.body ?? {};
    try {
      const out = await postBill(c, req.user!.name, { vendorName, vendorNit, date, base, expenseAccount, dueDays, vatTreatment, memo });
      res.status(201).json(out);
    } catch (e) {
      res.status(422).json({ error: (e as Error).message });
    }
  });

  // ---- Recurring bills (the phone bill, the rent, the cleaning contract) ----
  // A recurring bill is a template, not a posted document. Nothing hits the
  // ledger until someone posts a period from it — so the accountant keeps
  // control of the date and the amount, and every posting is still a normal
  // auditable entry.
  interface RecurringBill {
    id: string; clientId: string; name: string;
    vendorName: string; vendorNit: string;
    base: number; expenseAccount: string; vatTreatment: string;
    frequency: 'monthly' | 'quarterly' | 'annual';
    dayOfMonth: number; dueDays: number; active: boolean;
    /** Periods already posted from this template, e.g. ['2026-05','2026-06']. */
    posted: string[];
  }
  const recurringCol = new Collection<RecurringBill>('recurring-bills.json');
  const recurringList = (cid: string) => recurringCol.values().filter((r) => r.clientId === cid)
    .map(({ clientId, ...rest }) => { void clientId; return rest; });

  if (recurringCol.values().length === 0) {
    const seed: Omit<RecurringBill, 'id'>[] = [
      { clientId: 'andina', name: 'STC mobile & internet', vendorName: 'Saudi Telecom Company', vendorNit: '300000000000003',
        base: 3200, expenseAccount: '6000', vatTreatment: 'standard', frequency: 'monthly', dayOfMonth: 5, dueDays: 15, active: true, posted: [] },
      { clientId: 'andina', name: 'Warehouse rent — Riyadh', vendorName: 'Riyadh Properties Co.', vendorNit: '300000000000004',
        base: 45000, expenseAccount: '6000', vatTreatment: 'standard', frequency: 'monthly', dayOfMonth: 1, dueDays: 5, active: true, posted: [] },
      { clientId: 'andina', name: 'SEC electricity', vendorName: 'Saudi Electricity Company', vendorNit: '300000000000005',
        base: 8700, expenseAccount: '6000', vatTreatment: 'standard', frequency: 'monthly', dayOfMonth: 10, dueDays: 20, active: true, posted: [] },
    ];
    seed.forEach((r, i) => {
      const id = `RB-${String(i + 1).padStart(3, '0')}`;
      recurringCol.set(`${r.clientId}:${id}`, { id, ...r });
    });
  }

  app.get('/api/clients/:id/recurring-bills', (req, res) => {
    const c = withClient(req, res); if (!c) return;
    res.json(recurringList(c.meta.clientId));
  });

  app.post('/api/clients/:id/recurring-bills', requireRole('staff'), (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const { name, vendorName, vendorNit, base, expenseAccount, vatTreatment, frequency, dayOfMonth, dueDays } = req.body ?? {};
    if (!name || !vendorName) return res.status(400).json({ error: 'A template name and a vendor are required.' });
    if (!(Number(base) > 0)) return res.status(400).json({ error: 'A recurring amount greater than zero is required.' });
    const id = `RB-${randomUUID().slice(0, 8)}`;
    const freq: RecurringBill['frequency'] =
      frequency === 'quarterly' || frequency === 'annual' ? frequency : 'monthly';
    const rec: RecurringBill = {
      id, clientId: c.meta.clientId, name: String(name), vendorName: String(vendorName),
      vendorNit: String(vendorNit ?? ''), base: Number(base), expenseAccount: String(expenseAccount || '6000'),
      vatTreatment: String(vatTreatment || 'standard'), frequency: freq,
      dayOfMonth: Math.min(28, Math.max(1, Number(dayOfMonth) || 1)),
      dueDays: Number(dueDays) || 30, active: true, posted: [],
    };
    recurringCol.set(`${c.meta.clientId}:${id}`, rec);
    const { clientId, ...pub } = rec; void clientId;
    res.status(201).json(pub);
  });

  app.delete('/api/clients/:id/recurring-bills/:rid', requireRole('staff'), (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const key = `${c.meta.clientId}:${String(req.params.rid)}`;
    if (!recurringCol.get(key)) return res.status(404).json({ error: 'Recurring bill not found.' });
    recurringCol.delete(key);
    res.json({ ok: true });
  });

  // Post one period from a template. Refuses to post the same period twice —
  // duplicate recurring postings are one of the most common ways a set of books
  // quietly overstates expenses.
  app.post('/api/clients/:id/recurring-bills/:rid/post', requireRole('staff'), async (req: AuthedRequest, res) => {
    const c = withClient(req, res); if (!c) return;
    const key = `${c.meta.clientId}:${String(req.params.rid)}`;
    const rec = recurringCol.get(key);
    if (!rec) return res.status(404).json({ error: 'Recurring bill not found.' });
    const period = String(req.body?.period ?? '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'A period in YYYY-MM form is required.' });
    if (rec.posted.includes(period)) {
      return res.status(422).json({ error: `${rec.name} has already been posted for ${period}. Posting it twice would overstate the expense.` });
    }
    const date = `${period}-${String(rec.dayOfMonth).padStart(2, '0')}`;
    const amount = req.body?.base !== undefined ? Number(req.body.base) : rec.base;
    try {
      const out = await postBill(c, req.user!.name, {
        vendorName: rec.vendorName, vendorNit: rec.vendorNit, date, base: amount,
        expenseAccount: rec.expenseAccount, dueDays: rec.dueDays, vatTreatment: rec.vatTreatment,
        memo: `${rec.name} — ${period}`,
      });
      rec.posted = [...rec.posted, period];
      recurringCol.set(key, rec);
      res.status(201).json({ ...out, period });
    } catch (e) {
      res.status(422).json({ error: (e as Error).message });
    }
  });

  app.get('/api/clients/:id/open-items', (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const kind = req.query.kind as string | undefined;
    let items = [...itemsOf(c.meta.clientId).values()];
    if (kind === 'receivable' || kind === 'payable') items = items.filter((i) => i.kind === kind);
    res.json(items.filter(itemOpen).map(serItem));
  });

  // Record a payment against an open item (partial allowed).
  app.post('/api/clients/:id/payments', requireRole('staff'), async (req: AuthedRequest, res) => {
    const c = withClient(req, res); if (!c) return;
    const { openItemId, amount, date, bankAccount } = req.body ?? {};
    const item = itemsOf(c.meta.clientId).get(String(openItemId));
    if (!item) return res.status(404).json({ error: 'Document not found.' });
    const amt = pesos(Number(amount) || 0);
    if (amt <= 0n) return res.status(400).json({ error: 'An amount greater than zero is required.' });
    if (amt > outstanding(item)) return res.status(422).json({ error: 'The payment exceeds the amount still outstanding on this document.' });
    const bank = String(bankAccount || '1010');
    try {
      const lines = item.kind === 'receivable'
        ? [{ accountCode: bank, debit: amt }, { accountCode: '1100', credit: amt }]   // customer pays us
        : [{ accountCode: '2000', debit: amt }, { accountCode: bank, credit: amt }];   // we pay vendor
      const { entry } = await c.ledger.post({
        date: String(date), memo: `${item.kind === 'receivable' ? 'Payment received' : 'Payment to vendor'} — ${item.docNumber}`,
        source: item.contactName, user: req.user!.name, sourceDocument: item.docNumber, lines,
      });
      item.paid += amt;
      res.json({ ok: true, entryId: entry.id, item: serItem(item) });
    } catch (e) {
      res.status(422).json({ error: (e as Error).message });
    }
  });

  app.get('/api/clients/:id/aging', (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const kind = (req.query.kind === 'payable' ? 'payable' : 'receivable') as 'receivable' | 'payable';
    const asOf = String(req.query.asOf ?? '2026-06-30');
    const a = aging([...itemsOf(c.meta.clientId).values()], kind, asOf);
    res.json({
      kind: a.kind, asOf: a.asOf, total: toPesosNumber(a.total),
      buckets: {
        current: toPesosNumber(a.buckets.current), d1_30: toPesosNumber(a.buckets.d1_30),
        d31_60: toPesosNumber(a.buckets.d31_60), d61_90: toPesosNumber(a.buckets.d61_90), d90plus: toPesosNumber(a.buckets.d90plus),
      },
      rows: a.rows.map((r) => ({ ...serItem(r.item), daysOverdue: r.daysOverdue, bucket: r.bucket })),
    });
  });

  // Seed a little AR/AP demo data so the panel shows aging out of the box.
  const demoItems: [string, OpenItem['kind'], string, string, string, string, bigint, bigint][] = [
    ['andina', 'receivable', 'BinDawood Stores', 'FE-0002', '2026-05-05', '2026-06-04', pesos(8_568_000), 0n],
    ['andina', 'receivable', 'Al-Sadhan Markets', 'FE-0003', '2026-05-20', '2026-06-19', pesos(14_875_000), pesos(5_000_000)],
    ['andina', 'payable', 'Najd Distribution Co.', 'FC-1001', '2026-05-10', '2026-06-09', pesos(6_000_000), 0n],
    ['roble', 'receivable', 'Hail Trading Est.', 'FE-2001', '2026-06-04', '2026-07-04', pesos(2_784_600), 0n],
    ['roble', 'payable', 'Riyadh Properties Co.', 'FC-2001', '2026-05-15', '2026-06-14', pesos(1_450_000), 0n],
    ['esquina', 'payable', 'Jazan Coffee Supply', 'FC-3001', '2026-06-06', '2026-07-06', pesos(1_785_000), 0n],
  ];
  for (const [cid, kind, name, doc, date, due, original, paid] of demoItems) {
    itemSeq += 1;
    itemsOf(cid).set(`OI-${itemSeq}`, {
      id: `OI-${itemSeq}`, kind, contactId: '', contactName: name, docNumber: doc,
      date, dueDate: due, original, paid, entryId: '—',
    });
  }

  // ============================================================
  //  Taxes — the VAT schedule, the return worksheet and the rules
  // ============================================================
  // The accountant's note was "VAT and report being the same": a tax page that
  // only shows two totals cannot be tied to anything. These endpoints return
  // the LINE-BY-LINE schedule behind the return, the jurisdiction's treatment
  // catalogue, and a CSV of both.

  const serVatLine = (l: import('../domain/vatReport.js').VatReportLine) => ({
    entryId: l.entryId, date: l.date, docDate: l.docDate, docNumber: l.docNumber,
    counterparty: l.counterparty, memo: l.memo, side: l.side,
    base: toPesosNumber(l.base), vat: toPesosNumber(l.vat),
    rateBps: l.rateBps, treatment: l.treatment, reversed: l.reversed,
  });

  app.get('/api/clients/:id/vat-report', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const from = req.query.from ? String(req.query.from) : '0000-01-01';
    const to = req.query.to ? String(req.query.to) : '9999-12-31';
    const r = vatReport(await c.repo.listEntries(), from, to);
    const country = resolveCountry(c.meta.country);
    res.json({
      from: r.from, to: r.to,
      country: { id: country.id, name: country.name, vatBps: country.vatBps, currency: country.currency.code },
      rules: vatRules(c.meta.country),
      sales: r.sales.map(serVatLine),
      purchases: r.purchases.map(serVatLine),
      bands: r.bands.map((b) => ({ rateBps: b.rateBps, side: b.side, base: toPesosNumber(b.base), vat: toPesosNumber(b.vat), count: b.count })),
      totals: {
        standardSalesBase: toPesosNumber(r.totals.standardSalesBase),
        zeroOrExemptSalesBase: toPesosNumber(r.totals.zeroOrExemptSalesBase),
        outputVat: toPesosNumber(r.totals.outputVat),
        purchaseBase: toPesosNumber(r.totals.purchaseBase),
        inputVat: toPesosNumber(r.totals.inputVat),
        netVat: toPesosNumber(r.totals.netVat),
      },
      unexplained: r.unexplained.map((u) => ({ entryId: u.entryId, date: u.date, memo: u.memo, vat: toPesosNumber(u.vat), side: u.side })),
    });
  });

  /** The treatment catalogue + this jurisdiction's rules, for the Taxes page. */
  app.get('/api/clients/:id/tax-rules', (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const country = resolveCountry(c.meta.country);
    res.json({
      country: { id: country.id, name: country.name, nameAr: country.nameAr, flag: country.flag,
        vatBps: country.vatBps, corpTaxPct: country.corpTaxPct, zakatPct: country.zakatPct,
        eInvoicing: country.eInvoicing, currency: country.currency },
      rules: vatRules(c.meta.country),
      treatments: TREATMENTS,
    });
  });

  app.get('/api/clients/:id/export/vat-report.csv', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const from = req.query.from ? String(req.query.from) : '0000-01-01';
    const to = req.query.to ? String(req.query.to) : '9999-12-31';
    const r = vatReport(await c.repo.listEntries(), from, to);
    const rows: (string | number | null)[][] = [[
      'side', 'entry', 'posting_date', 'document_date', 'document_no', 'counterparty',
      'memo', 'net_base', 'vat', 'rate_pct', 'treatment', 'reversed',
    ]];
    for (const l of [...r.sales, ...r.purchases]) {
      rows.push([l.side, l.entryId, l.date, l.docDate ?? '', l.docNumber ?? '', l.counterparty, l.memo,
        toPesosNumber(l.base), toPesosNumber(l.vat),
        l.rateBps === null ? '' : (l.rateBps / 100).toFixed(2), l.treatment, l.reversed ? 'yes' : '']);
    }
    rows.push([]);
    rows.push(['', '', '', '', '', '', 'Standard-rated sales (net)', toPesosNumber(r.totals.standardSalesBase)]);
    rows.push(['', '', '', '', '', '', 'Zero-rated / exempt sales (net)', toPesosNumber(r.totals.zeroOrExemptSalesBase)]);
    rows.push(['', '', '', '', '', '', 'Output VAT', toPesosNumber(r.totals.outputVat)]);
    rows.push(['', '', '', '', '', '', 'Purchases (net)', toPesosNumber(r.totals.purchaseBase)]);
    rows.push(['', '', '', '', '', '', 'Input VAT', toPesosNumber(r.totals.inputVat)]);
    rows.push(['', '', '', '', '', '', 'Net VAT payable / (refundable)', toPesosNumber(r.totals.netVat)]);
    sendCsv(res, `vat-report-${r.from}-to-${r.to}.csv`, rows);
  });

  // ============================================================
  //  Financial statement exports — everything extractable
  // ============================================================
  app.get('/api/clients/:id/export/income-statement.csv', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const r = incomeStatement(await c.repo.listEntries());
    sendCsv(res, 'income-statement.csv', [
      ['line', 'amount'],
      ['Revenue', toPesosNumber(r.ingresos)],
      ['Cost of sales', toPesosNumber(r.costo)],
      ['Gross profit', toPesosNumber(r.ingresos - r.costo)],
      ['Operating expenses', toPesosNumber(r.gastos)],
      ['Profit for the period', toPesosNumber(r.utilidad)],
    ]);
  });

  app.get('/api/clients/:id/export/balance-sheet.csv', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const entries = await c.repo.listEntries();
    const bs = balanceSheet(entries);
    const nat = (code: string) => toPesosNumber(naturalBalance(code, entries));
    sendCsv(res, 'balance-sheet.csv', [
      ['section', 'code', 'account', 'amount'],
      ...['1000', '1010', '1100', '1150', '1160', '1200', '1500'].map((code) =>
        ['Assets', code, getAccount(code).name, nat(code)]),
      ['Assets', '', 'Total assets', toPesosNumber(bs.activos)],
      ...['2000', '2100', '2110'].map((code) => ['Liabilities', code, getAccount(code).name, nat(code)]),
      ['Liabilities', '', 'Total liabilities', toPesosNumber(bs.pasivos)],
      ['Equity', '3000', getAccount('3000').name, nat('3000')],
      ['Equity', '', 'Retained profit for the period', toPesosNumber(incomeStatement(entries).utilidad)],
      ['Equity', '', 'Total equity', toPesosNumber(bs.patrimonio)],
      ['Check', '', 'Assets = Liabilities + Equity', bs.cuadra ? 'balanced' : 'OUT OF BALANCE'],
    ]);
  });

  app.get('/api/clients/:id/export/cash-flow.csv', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const r = cashFlowStatement(await c.repo.listEntries());
    sendCsv(res, 'cash-flow.csv', [
      ['line', 'amount'],
      ['Opening cash', toPesosNumber(r.openingCash)],
      ['Operating activities', toPesosNumber(r.operating)],
      ['Investing activities', toPesosNumber(r.investing)],
      ['Financing activities', toPesosNumber(r.financing)],
      ['Net change in cash', toPesosNumber(r.netChange)],
      ['Closing cash', toPesosNumber(r.closingCash)],
      ['Check', r.reconciles ? 'reconciles' : 'DOES NOT RECONCILE'],
    ]);
  });

  /** General ledger: every account, every movement, with a running balance. */
  app.get('/api/clients/:id/general-ledger', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const entries = await c.repo.listEntries();
    const codes = [...new Set(entries.flatMap((e) => e.lines.map((l) => l.accountCode)))].sort();
    res.json(codes.map((code) => {
      const a = accountExists(code) ? getAccount(code) : null;
      let running = 0n;
      const rows: unknown[] = [];
      for (const e of entries) {
        for (const l of e.lines) {
          if (l.accountCode !== code) continue;
          const signed = a && a.normal === 'C' ? l.credit - l.debit : l.debit - l.credit;
          running += signed;
          rows.push({
            entryId: e.id, date: e.date, docNumber: e.sourceDocument ?? null, memo: e.memo,
            counterparty: e.source, debit: toPesosNumber(l.debit), credit: toPesosNumber(l.credit),
            balance: toPesosNumber(running), reversed: e.reversed,
          });
        }
      }
      return { code, name: a ? a.name : '(unmapped)', nameAr: a?.nameAr ?? null, normal: a?.normal ?? 'D', closing: toPesosNumber(running), rows };
    }));
  });

  app.get('/api/clients/:id/export/general-ledger.csv', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const entries = await c.repo.listEntries();
    const codes = [...new Set(entries.flatMap((e) => e.lines.map((l) => l.accountCode)))].sort();
    const rows: (string | number | null)[][] = [[
      'code', 'account', 'entry', 'date', 'document_no', 'memo', 'counterparty', 'debit', 'credit', 'running_balance',
    ]];
    for (const code of codes) {
      const a = accountExists(code) ? getAccount(code) : null;
      let running = 0n;
      for (const e of entries) {
        for (const l of e.lines) {
          if (l.accountCode !== code) continue;
          running += a && a.normal === 'C' ? l.credit - l.debit : l.debit - l.credit;
          rows.push([code, a ? a.name : '(unmapped)', e.id, e.date, e.sourceDocument ?? '', e.memo, e.source,
            toPesosNumber(l.debit), toPesosNumber(l.credit), toPesosNumber(running)]);
        }
      }
    }
    sendCsv(res, 'general-ledger.csv', rows);
  });

  app.get('/api/clients/:id/export/aging.csv', (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const kind = (req.query.kind === 'payable' ? 'payable' : 'receivable') as 'receivable' | 'payable';
    const asOf = String(req.query.asOf ?? '2026-06-30');
    const a = aging([...itemsOf(c.meta.clientId).values()], kind, asOf);
    sendCsv(res, `aging-${kind}.csv`, [
      [`${kind === 'payable' ? 'Payables' : 'Receivables'} aging as of ${asOf}`],
      [],
      ['counterparty', 'document', 'date', 'due_date', 'original', 'paid', 'outstanding', 'days_overdue', 'bucket'],
      ...a.rows.map((r) => [r.item.contactName, r.item.docNumber, r.item.date, r.item.dueDate,
        toPesosNumber(r.item.original), toPesosNumber(r.item.paid), toPesosNumber(outstanding(r.item)),
        r.daysOverdue, r.bucket]),
      [],
      ['Current', '', '', '', '', '', toPesosNumber(a.buckets.current)],
      ['1-30 days', '', '', '', '', '', toPesosNumber(a.buckets.d1_30)],
      ['31-60 days', '', '', '', '', '', toPesosNumber(a.buckets.d31_60)],
      ['61-90 days', '', '', '', '', '', toPesosNumber(a.buckets.d61_90)],
      ['90+ days', '', '', '', '', '', toPesosNumber(a.buckets.d90plus)],
      ['TOTAL', '', '', '', '', '', toPesosNumber(a.total)],
    ]);
  });

  app.get('/api/clients/:id/export/vendors.csv', (req, res) => {
    const c = withClient(req, res); if (!c) return;
    sendCsv(res, 'vendors.csv', [
      ['name', 'tax_registration', 'type', 'phone', 'email', 'bank_account'],
      ...contactsList(c.meta.clientId).map((v) => [v.name, v.nit, v.kind, v.phone ?? '', v.email ?? '', v.bank ?? '']),
    ]);
  });

  app.get('/api/clients/:id/export/open-items.csv', (req, res) => {
    const c = withClient(req, res); if (!c) return;
    sendCsv(res, 'open-items.csv', [
      ['kind', 'counterparty', 'document', 'date', 'due_date', 'original', 'paid', 'outstanding', 'entry'],
      ...[...itemsOf(c.meta.clientId).values()].map((i) => [i.kind, i.contactName, i.docNumber, i.date, i.dueDate,
        toPesosNumber(i.original), toPesosNumber(i.paid), toPesosNumber(outstanding(i)), i.entryId]),
    ]);
  });

  app.get('/api/clients/:id/export/inventory.csv', (req, res) => {
    const c = withClient(req, res); if (!c) return;
    sendCsv(res, 'inventory.csv', [
      ['sku', 'name', 'unit', 'cost', 'price', 'stock', 'stock_value'],
      ...productsList(c.meta.clientId).map((p) => [p.sku, p.name, p.unit, p.cost, p.price, p.stock, +(p.cost * p.stock).toFixed(2)]),
    ]);
  });

  // ============================================================
  //  Bank reconciliation: something to work with
  // ============================================================
  // "Nothing to work with" was fair — the page shipped with two hardcoded rows
  // and no way to get a real statement. This generates a plausible statement
  // from the client's OWN cash and bank movements, so reconciliation can be
  // exercised end to end: download, tweak a row, upload, see the breaks.
  const cashMovements = async (c: NonNullable<ReturnType<typeof withClient>>) => {
    const entries = await c.repo.listEntries();
    const out: { date: string; description: string; amount: number }[] = [];
    for (const e of entries) {
      if (e.reversed) continue;
      let delta = 0n;
      for (const l of e.lines) {
        if (!(CASH_AND_BANK as readonly string[]).includes(l.accountCode)) continue;
        delta += l.debit - l.credit;
      }
      if (delta === 0n) continue;
      out.push({ date: e.date, description: e.source || e.memo, amount: toPesosNumber(delta) });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  };

  app.get('/api/clients/:id/bank-statement-sample', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    res.json(await cashMovements(c));
  });

  app.get('/api/clients/:id/export/bank-statement-sample.csv', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const rows = await cashMovements(c);
    sendCsv(res, 'bank-statement.csv', [
      ['date', 'description', 'amount'],
      ...rows.map((r) => [r.date, r.description, r.amount]),
    ]);
  });

  // Serve the API-backed console UI at /
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  return app;
}
