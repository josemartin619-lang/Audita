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
import { CHART_OF_ACCOUNTS } from '../domain/accounts.js';
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
import { Collection } from '../persistence/store.js';
import type { ClientMeta } from '../services/firmWorkspace.js';

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

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'audita', version: '0.6.0-ksa' }));

  // ---- Auth ----
  // Brute-force protection: cap login attempts per IP.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiados intentos de inicio de sesión. Intente más tarde.' },
  });
  app.post('/api/auth/login', loginLimiter, (req, res) => {
    const { email, password } = req.body ?? {};
    const user = email ? users.find(String(email)) : undefined;
    if (!user || !verifyPassword(String(password ?? ''), user.passwordHash)) {
      return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    }
    const token = signToken({ sub: user.id, email: user.email, name: user.name, role: user.role, firmId: user.firmId });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  });

  app.get('/api/me', (req: AuthedRequest, res) => res.json(req.user));

  // Chart of accounts (for the entry form).
  app.get('/api/accounts', (_req, res) => {
    res.json(CHART_OF_ACCOUNTS.map((a) => ({ code: a.code, name: a.name, nameAr: a.nameAr, type: a.type, normal: a.normal })));
  });

  // --- Firm console: all clients ranked by risk ---
  app.get('/api/clients', async (_req, res) => {
    res.json(await firm.console());
  });

  app.post('/api/clients', requireRole('accountant'), (req, res) => {
    const { clientId, name, ofeNit } = req.body ?? {};
    if (!clientId || !name || !ofeNit) {
      return res.status(400).json({ error: 'clientId, name y ofeNit son obligatorios.' });
    }
    try {
      firm.addClient({ clientId, name, ofeNit });
      clientStore?.set(String(clientId), { clientId, name, ofeNit });
      res.status(201).json({ clientId, name, ofeNit });
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  // helper to resolve a client or 404
  const withClient = (req: Request, res: Response) => {
    try {
      return firm.client(String(req.params.id));
    } catch {
      res.status(404).json({ error: `Cliente no encontrado: ${req.params.id}` });
      return null;
    }
  };

  app.get('/api/clients/:id/entries', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    res.json((await c.repo.listEntries()).map(serializeEntry));
  });

  app.post('/api/clients/:id/entries', requireRole('staff'), async (req: AuthedRequest, res) => {
    const c = withClient(req, res); if (!c) return;
    const { date, memo, source, lines } = req.body ?? {};
    if (!Array.isArray(lines)) return res.status(400).json({ error: 'lines[] requerido.' });
    try {
      const draftLines = lines.map((l: { accountCode: string; debit?: number; credit?: number }) => ({
        accountCode: l.accountCode,
        debit: l.debit ? pesos(l.debit) : undefined,
        credit: l.credit ? pesos(l.credit) : undefined,
      }));
      const { entry, findings } = await c.ledger.post({ date, memo, source, user: req.user!.name, lines: draftLines });
      res.status(201).json({ entry: serializeEntry(entry), findings });
    } catch (e) {
      res.status(422).json({ error: (e as Error).message });
    }
  });

  app.post('/api/clients/:id/invoices', requireRole('staff'), async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const { client, acquirerId, date, concept, base, reteIcaBps, reteIvaBps } = req.body ?? {};
    if (!client || !base) return res.status(400).json({ error: 'client y base son obligatorios.' });
    try {
      const inv = await c.invoices.issue({
        client, acquirerId: acquirerId ?? '222222', date, concept: concept ?? 'Venta',
        base: pesos(Number(base)), ofeNit: c.meta.ofeNit,
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
      return res.status(400).json({ error: 'status inválido.' });
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
      return res.status(400).json({ error: 'accountCode, period y supportBalance son obligatorios.' });
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
    if (!clientId) return res.status(404).json({ error: 'Enlace de verificación inválido o expirado.' });
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
    } else return res.status(400).json({ error: 'Envíe statement[] o csv.' });
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
    if (!entry) return res.status(404).json({ error: 'Asiento no encontrado.' });
    if (entry.user === req.user!.name) {
      return res.status(422).json({ error: 'No puede revisar su propio asiento (segregación de funciones).' });
    }
    const ev = c.ledger.auditTrail().append({
      action: 'ENTRY_REVIEWED', ref: eid,
      detail: { reviewer: req.user!.name, role: req.user!.role }, user: req.user!.name, ts: new Date().toISOString(),
    });
    await c.repo.appendAudit(ev);
    res.json({ ok: true, reviewer: req.user!.name });
  });

  // ---- CSV exports (get your data out — to Excel / tax software) ----
  app.get('/api/clients/:id/export/trial-balance.csv', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const tb = trialBalance(await c.repo.listEntries());
    const rows = [['code', 'account', 'debit', 'credit'],
      ...tb.rows.map((r) => [r.code, r.name, toPesosNumber(r.debit), toPesosNumber(r.credit)])];
    res.setHeader('content-type', 'text/csv');
    res.setHeader('content-disposition', 'attachment; filename="trial-balance.csv"');
    res.send(rows.map((r) => r.join(',')).join('\n'));
  });

  app.get('/api/clients/:id/export/journal.csv', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const entries = await c.repo.listEntries();
    const rows: (string | number)[][] = [['entry', 'date', 'account', 'account_name', 'debit', 'credit', 'memo', 'source']];
    for (const e of entries) {
      for (const l of e.lines) {
        rows.push([e.id, e.date, l.accountCode, `"${l.accountCode}"`, toPesosNumber(l.debit), toPesosNumber(l.credit),
          `"${e.memo.replace(/"/g, '""')}"`, `"${e.source.replace(/"/g, '""')}"`]);
      }
    }
    res.setHeader('content-type', 'text/csv');
    res.setHeader('content-disposition', 'attachment; filename="journal.csv"');
    res.send(rows.map((r) => r.join(',')).join('\n'));
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
    if (!name || !Array.isArray(lines)) return res.status(400).json({ error: 'name y lines[] requeridos.' });
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
    if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'lines[] requerido.' });
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
    const { name, nit, kind } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name is required.' });
    const k: Contact['kind'] = kind === 'customer' || kind === 'vendor' ? kind : 'both';
    const id = `CT-${randomUUID().slice(0, 8)}`;
    const contact: Contact & { clientId: string } = { id, clientId: c.meta.clientId, name: String(name), nit: String(nit ?? ''), kind: k };
    contactsCol.set(`${c.meta.clientId}:${id}`, contact);
    res.status(201).json({ id, name: contact.name, nit: contact.nit, kind: k });
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

  // Vendor bill: books Dr expense + Dr IVA descontable, Cr retención, Cr proveedores; opens a payable.
  app.post('/api/clients/:id/bills', requireRole('staff'), async (req: AuthedRequest, res) => {
    const c = withClient(req, res); if (!c) return;
    const { vendorName, vendorNit, date, base, expenseAccount, applyRete, dueDays } = req.body ?? {};
    const baseM = pesos(Number(base) || 0);
    if (!vendorName || baseM <= 0n) return res.status(400).json({ error: 'vendorName y base (>0) requeridos.' });
    const acct = String(expenseAccount || '6000');
    const iva = applyRateBps(baseM, 1500); // KSA VAT 15%
    const rete = 0n; // no domestic buyer withholding in KSA (applyRete kept for API compat)
    void applyRete;
    const payable = baseM + iva - rete;
    billSeq += 1;
    const number = `FC-${String(billSeq).padStart(4, '0')}`;
    try {
      const { entry, findings } = await c.ledger.post({
        date: String(date), memo: `Purchase invoice ${number} — ${vendorName}`, source: String(vendorName), user: req.user!.name,
        sourceDocument: number,
        lines: [
          { accountCode: acct, debit: baseM },
          { accountCode: '1150', debit: iva },
          ...(rete > 0n ? [{ accountCode: '2110', credit: rete }] : []),
          { accountCode: '2000', credit: payable },
        ],
      });
      itemSeq += 1;
      const item: OpenItem = {
        id: `OI-${itemSeq}`, kind: 'payable', contactId: String(vendorNit ?? ''), contactName: String(vendorName),
        docNumber: number, date: String(date), dueDate: addDays(String(date), Number(dueDays) || 30),
        original: payable, paid: 0n, entryId: entry.id,
      };
      itemsOf(c.meta.clientId).set(item.id, item);
      res.status(201).json({ bill: { number, entryId: entry.id, payable: toPesosNumber(payable) }, item: serItem(item), findings });
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
    if (!item) return res.status(404).json({ error: 'Documento no encontrado.' });
    const amt = pesos(Number(amount) || 0);
    if (amt <= 0n) return res.status(400).json({ error: 'amount (>0) requerido.' });
    if (amt > outstanding(item)) return res.status(422).json({ error: 'El pago excede el saldo pendiente.' });
    const bank = String(bankAccount || '1010');
    try {
      const lines = item.kind === 'receivable'
        ? [{ accountCode: bank, debit: amt }, { accountCode: '1100', credit: amt }]   // customer pays us
        : [{ accountCode: '2000', debit: amt }, { accountCode: bank, credit: amt }];   // we pay vendor
      const { entry } = await c.ledger.post({
        date: String(date), memo: `Pago ${item.kind === 'receivable' ? 'recibido' : 'a proveedor'} — ${item.docNumber}`,
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
    ['roble', 'payable', 'Inmobiliaria Centro', 'FC-2001', '2026-05-15', '2026-06-14', pesos(1_450_000), 0n],
    ['esquina', 'payable', 'Proveedor Café', 'FC-3001', '2026-06-06', '2026-07-06', pesos(1_785_000), 0n],
  ];
  for (const [cid, kind, name, doc, date, due, original, paid] of demoItems) {
    itemSeq += 1;
    itemsOf(cid).set(`OI-${itemSeq}`, {
      id: `OI-${itemSeq}`, kind, contactId: '', contactName: name, docNumber: doc,
      date, dueDate: due, original, paid, entryId: '—',
    });
  }

  // Serve the API-backed console UI at /
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  return app;
}
