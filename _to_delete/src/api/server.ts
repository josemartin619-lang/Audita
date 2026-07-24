/**
 * REST API over the audit-first core. Express, thin: it validates input, calls
 * the domain services, and serializes at the edge. Auth is an API key; every
 * request is scoped to a client (tenant) whose books are structurally isolated
 * in the FirmWorkspace.
 *
 * Run: `npm run api`  (PORT, AUDITA_API_KEY from env)
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirmWorkspace } from '../services/firmWorkspace.js';
import { pesos } from '../domain/money.js';
import { serializeEntry, serializeReports } from './serialize.js';
import { assembleClosePackage, buildWorkingPaper } from '../domain/workingPapers.js';
import { naturalBalance } from '../domain/reports.js';
import { CHART_OF_ACCOUNTS } from '../domain/accounts.js';
import { benfordAnalysis, velocityAnalysis } from '../domain/controls/analysis.js';
import { isOpen, type FindingStatus } from '../domain/findings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(firm: FirmWorkspace) {
  const app = express();
  app.use(express.json());

  const API_KEY = process.env.AUDITA_API_KEY ?? 'dev-key';
  const auth = (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/health' || !req.path.startsWith('/api/')) return next();
    if (req.header('x-api-key') !== API_KEY) {
      return res.status(401).json({ error: 'API key inválida o ausente (x-api-key).' });
    }
    next();
  };
  app.use(auth);

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'audita', version: '0.2.0' }));

  // Chart of accounts (for the entry form).
  app.get('/api/accounts', (_req, res) => {
    res.json(CHART_OF_ACCOUNTS.map((a) => ({ code: a.code, name: a.name, type: a.type, normal: a.normal })));
  });

  // --- Firm console: all clients ranked by risk ---
  app.get('/api/clients', async (_req, res) => {
    res.json(await firm.console());
  });

  app.post('/api/clients', (req, res) => {
    const { clientId, name, ofeNit } = req.body ?? {};
    if (!clientId || !name || !ofeNit) {
      return res.status(400).json({ error: 'clientId, name y ofeNit son obligatorios.' });
    }
    try {
      firm.addClient({ clientId, name, ofeNit });
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

  app.post('/api/clients/:id/entries', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const { date, memo, source, lines } = req.body ?? {};
    if (!Array.isArray(lines)) return res.status(400).json({ error: 'lines[] requerido.' });
    try {
      const draftLines = lines.map((l: { accountCode: string; debit?: number; credit?: number }) => ({
        accountCode: l.accountCode,
        debit: l.debit ? pesos(l.debit) : undefined,
        credit: l.credit ? pesos(l.credit) : undefined,
      }));
      const { entry, findings } = await c.ledger.post({ date, memo, source, user: 'api', lines: draftLines });
      res.status(201).json({ entry: serializeEntry(entry), findings });
    } catch (e) {
      res.status(422).json({ error: (e as Error).message });
    }
  });

  app.post('/api/clients/:id/invoices', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    const { client, acquirerId, date, concept, base } = req.body ?? {};
    if (!client || !base) return res.status(400).json({ error: 'client y base son obligatorios.' });
    try {
      const inv = await c.invoices.issue({
        client, acquirerId: acquirerId ?? '222222', date, concept: concept ?? 'Venta',
        base: pesos(Number(base)), ofeNit: c.meta.ofeNit,
      });
      res.status(201).json({
        number: inv.number, cufe: inv.cufe, status: inv.status,
        base: Number(base), entryId: inv.entryId,
      });
    } catch (e) {
      res.status(422).json({ error: (e as Error).message });
    }
  });

  app.get('/api/clients/:id/findings', async (req, res) => {
    const c = withClient(req, res); if (!c) return;
    res.json(await c.repo.listFindings());
  });

  app.post('/api/clients/:id/findings/:fid/status', async (req, res) => {
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
      id: 'WP-111005', accountCode: '111005', period, entries,
      supportBalance: naturalBalance('111005', entries), preparedBy: 'api', createdAt: new Date().toISOString(),
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

  // Serve the API-backed console UI at /
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  return app;
}
