import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/api/server.js';
import { seedFirm } from '../src/api/seed.js';
import { seedUsers } from '../src/api/auth.js';

let app: Express;
let KEY: Record<string, string>; // partner auth header
let STAFF: Record<string, string>;
let VIEWER: Record<string, string>;

async function login(email: string) {
  const r = await request(app).post('/api/auth/login').send({ email, password: 'audita' }).expect(200);
  return { Authorization: `Bearer ${r.body.token}` };
}

beforeAll(async () => {
  app = createApp(await seedFirm(), seedUsers());
  KEY = await login('ana@audita.co');      // partner
  STAFF = await login('sofia@audita.co');   // staff
  VIEWER = await login('cliente@andina.co'); // viewer
});

describe('REST API', () => {
  it('rejects requests without a token', async () => {
    await request(app).get('/api/clients').expect(401);
  });

  it('rejects a bad password', async () => {
    await request(app).post('/api/auth/login').send({ email: 'ana@audita.co', password: 'wrong' }).expect(401);
  });

  it('health check is public', async () => {
    const r = await request(app).get('/health').expect(200);
    expect(r.body.service).toBe('audita');
  });

  it('lists clients ranked by risk', async () => {
    const r = await request(app).get('/api/clients').set(KEY).expect(200);
    expect(r.body.length).toBe(3);
    // sorted highest risk first
    expect(r.body[0].risk.score).toBeGreaterThanOrEqual(r.body[1].risk.score);
    // the anomaly-laden client should be riskiest
    expect(r.body[0].clientId).toBe('andina');
  });

  it('returns balanced reports for a client', async () => {
    const r = await request(app).get('/api/clients/andina/reports').set(KEY).expect(200);
    expect(r.body.trialBalance.balanced).toBe(true);
    expect(r.body.trialBalance.totalDebit).toBe(r.body.trialBalance.totalCredit);
  });

  it('posts an entry and rejects an unbalanced one', async () => {
    await request(app).post('/api/clients/roble/entries').set(KEY)
      .send({ date: '2026-06-20', memo: 'ok', source: 's', lines: [{ accountCode: '1010', debit: 100 }, { accountCode: '4000', credit: 100 }] })
      .expect(201);
    await request(app).post('/api/clients/roble/entries').set(KEY)
      .send({ date: '2026-06-20', memo: 'bad', source: 's', lines: [{ accountCode: '1010', debit: 100 }, { accountCode: '4000', credit: 90 }] })
      .expect(422);
  });

  it('serves the chart of accounts for the entry form', async () => {
    const r = await request(app).get('/api/accounts').set(KEY).expect(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.find((a: { code: string }) => a.code === '4000')).toBeTruthy();
  });

  it('issues an invoice with a CUFE', async () => {
    const r = await request(app).post('/api/clients/roble/invoices').set(KEY)
      .send({ client: 'Nuevo Cliente', date: '2026-06-21', base: 1000000 }).expect(201);
    expect(r.body.cufe).toMatch(/^[0-9a-f]{64}$/); // ZATCA invoice hash (SHA-256)
  });

  it('verifies the audit chain is valid via the API', async () => {
    const r = await request(app).get('/api/clients/andina/audit').set(KEY).expect(200);
    expect(r.body.verification.valid).toBe(true);
  });

  it('proves a number: provenance traces a balance to entries with hashes', async () => {
    const r = await request(app).get('/api/clients/andina/provenance/4000').set(KEY).expect(200);
    expect(r.body.code).toBe('4000');
    expect(r.body.lines.length).toBeGreaterThan(0);
    // every contributing line carries the evidence hash of its entry
    expect(r.body.lines.every((l: { hash: string | null }) => typeof l.hash === 'string')).toBe(true);
  });

  it('creates and lists a working paper with a tie-out difference', async () => {
    const r = await request(app).post('/api/clients/roble/working-papers').set(KEY)
      .send({ accountCode: '1010', period: '2026-06', supportBalance: 1, notes: 'test' }).expect(201);
    expect(r.body.accountCode).toBe('1010');
    // support (1) != booked, so it must NOT tie
    expect(r.body.difference).not.toBe(0);
    const list = await request(app).get('/api/clients/roble/working-papers').set(KEY).expect(200);
    expect(list.body.find((w: { id: string }) => w.id === r.body.id)).toBeTruthy();
  });

  it('verifiable share: creates a token and serves a PUBLIC bundle (no API key)', async () => {
    const s = await request(app).post('/api/clients/andina/share').set(KEY).expect(201);
    expect(s.body.token).toBeTruthy();
    // the verify bundle must NOT require the api key — that is the whole point
    const v = await request(app).get(`/api/verify/${s.body.token}`).expect(200);
    expect(v.body.client).toContain('Rajhi');
    expect(Array.isArray(v.body.auditEvents)).toBe(true);
    expect(v.body.auditEvents[0].prevHash).toBe('GENESIS');
    expect(v.body.seal).toBe(v.body.auditEvents[v.body.auditEvents.length - 1].hash);
  });

  it('rejects an invalid verification token', async () => {
    await request(app).get('/api/verify/not-a-real-token').expect(404);
  });

  it('updates a finding status', async () => {
    const findings = (await request(app).get('/api/clients/andina/findings').set(KEY)).body;
    const open = findings.find((f: { status: string }) => f.status === 'open');
    await request(app).post(`/api/clients/andina/findings/${open.id}/status`).set(KEY)
      .send({ status: 'cleared', note: 'soporte verificado' }).expect(200);
    const after = (await request(app).get('/api/clients/andina/findings').set(KEY)).body;
    expect(after.find((f: { id: string }) => f.id === open.id).status).toBe('cleared');
  });

  it('enforces roles: a viewer can read but not post', async () => {
    await request(app).get('/api/clients').set(VIEWER).expect(200); // read: ok
    await request(app).post('/api/clients/roble/entries').set(VIEWER)
      .send({ date: '2026-06-22', memo: 'x', source: 's', lines: [{ accountCode: '1010', debit: 100 }, { accountCode: '4000', credit: 100 }] })
      .expect(403); // write: forbidden
  });

  it('enforces roles: staff cannot change a finding status (accountant+ only)', async () => {
    const findings = (await request(app).get('/api/clients/roble/findings').set(STAFF)).body;
    if (findings.length) {
      await request(app).post(`/api/clients/roble/findings/${findings[0].id}/status`).set(STAFF)
        .send({ status: 'cleared' }).expect(403);
    }
  });

  it('reconciles a statement against the ledger', async () => {
    // andina has an opening capital of 60,000,000 debited to bank on 2026-06-01
    const r = await request(app).post('/api/clients/andina/reconcile').set(STAFF)
      .send({ statement: [
        { date: '2026-06-01', description: 'Aporte socios', amount: 60000000 }, // should match
        { date: '2026-06-30', description: 'Comisión bancaria', amount: -45000 }, // no match
      ] }).expect(200);
    expect(r.body.matchedCount).toBe(1);
    expect(r.body.unmatchedStatement.length).toBe(1);
    expect(r.body.unmatchedStatement[0].description).toContain('Comisión');
  });

  it('maker-checker: a senior can sign off an entry and it is logged', async () => {
    // staff posts an entry
    const posted = await request(app).post('/api/clients/roble/entries').set(STAFF)
      .send({ date: '2026-06-23', memo: 'Gasto menor', source: 'Caja', lines: [{ accountCode: '6000', debit: 50000 }, { accountCode: '1010', credit: 50000 }] })
      .expect(201);
    const eid = posted.body.entry.id;
    // a partner reviews it
    await request(app).post(`/api/clients/roble/entries/${eid}/review`).set(KEY).expect(200);
    // the review is in the immutable trail
    const audit = (await request(app).get('/api/clients/roble/audit').set(KEY)).body;
    expect(audit.events.some((e: { action: string; ref: string }) => e.action === 'ENTRY_REVIEWED' && e.ref === eid)).toBe(true);
    expect(audit.verification.valid).toBe(true);
  });

  it('exports financial statements as a PDF stamped with the ledger fingerprint', async () => {
    const r = await request(app).get('/api/clients/andina/statements.pdf?period=2026-06&lang=es').set(KEY)
      .buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); })
      .expect(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.body.slice(0, 5).toString()).toBe('%PDF-'); // valid PDF header
    expect(r.body.length).toBeGreaterThan(1000);
  });

  it('exports the trial balance as CSV', async () => {
    const r = await request(app).get('/api/clients/andina/export/trial-balance.csv').set(KEY).expect(200);
    expect(r.headers['content-type']).toContain('text/csv');
    // A UTF-8 BOM is emitted on purpose so Excel opens Arabic account names
    // correctly, and rows are CRLF-terminated for the same reason.
    expect(r.text.startsWith('\uFEFF')).toBe(true);
    expect(r.text.replace('\uFEFF', '').split('\r\n')[0]).toBe('code,account,debit,credit');
  });

  it('rejects an unbalanced recurring template, accepts a balanced one, and posts it', async () => {
    // unbalanced -> 422
    await request(app).post('/api/clients/roble/templates').set(STAFF)
      .send({ name: 'bad', lines: [{ accountCode: '6000', debit: 100 }, { accountCode: '1010', credit: 90 }] })
      .expect(422);
    // balanced monthly rent template
    const t = await request(app).post('/api/clients/roble/templates').set(STAFF)
      .send({ name: 'Arriendo mensual', memo: 'Arriendo oficina', source: 'Inmobiliaria',
        lines: [{ accountCode: '6000', debit: 1450000 }, { accountCode: '1010', credit: 1450000 }] })
      .expect(201);
    // post it for a period -> creates a balanced entry
    const posted = await request(app).post(`/api/clients/roble/templates/${t.body.id}/post`).set(STAFF)
      .send({ date: '2026-07-01' }).expect(201);
    expect(posted.body.entry.amount).toBe(1450000);
    expect(posted.body.entry.memo).toContain('Arriendo');
  });

  it('imports opening balances as a balanced entry and rejects an unbalanced set', async () => {
    await request(app).post('/api/clients/roble/opening-balances').set(KEY)
      .send({ date: '2026-01-01', lines: [{ accountCode: '1010', debit: 5000000 }, { accountCode: '3000', credit: 5000000 }] })
      .expect(201);
    await request(app).post('/api/clients/roble/opening-balances').set(KEY)
      .send({ date: '2026-01-01', lines: [{ accountCode: '1010', debit: 5000000 }, { accountCode: '3000', credit: 4000000 }] })
      .expect(422);
    // staff cannot import opening balances (accountant+)
    await request(app).post('/api/clients/roble/opening-balances').set(STAFF)
      .send({ date: '2026-01-01', lines: [{ accountCode: '1010', debit: 1 }, { accountCode: '3000', credit: 1 }] })
      .expect(403);
  });

  it('applies ReteICA/ReteIVA on an invoice and reflects them in the tax report', async () => {
    const inv = await request(app).post('/api/clients/esquina/invoices').set(STAFF)
      .send({ client: 'Cliente Rete', date: '2026-06-10', base: 10000000, reteIcaBps: 69, reteIvaBps: 1500 }).expect(201);
    // ReteICA 0.69% of 10,000,000 = 69,000 ; ReteIVA 15% of VAT(1,500,000) = 225,000 ; no reteFuente in KSA
    expect(inv.body.reteIca).toBe(69000);
    expect(inv.body.reteIva).toBe(225000);
    const rep = await request(app).get('/api/clients/esquina/reports').set(KEY).expect(200);
    // withholding in our favor = reteica(69,000)+reteiva(225,000) = 294,000, a positive asset
    expect(rep.body.taxPosition.retencionesAFavor).toBe(294000);
    expect(rep.body.trialBalance.balanced).toBe(true);
  });

  it('locks a period (partner) and then refuses to post into it', async () => {
    // partner locks 2026-06 for esquina
    const lock = await request(app).post('/api/clients/esquina/periods/2026-06/lock').set(KEY).expect(200);
    expect(lock.body.locked).toContain('2026-06');
    // staff cannot lock (partner-only)
    await request(app).post('/api/clients/esquina/periods/2026-07/lock').set(STAFF).expect(403);
    // posting into the locked period is rejected
    await request(app).post('/api/clients/esquina/entries').set(STAFF)
      .send({ date: '2026-06-20', memo: 'late', source: 's', lines: [{ accountCode: '6000', debit: 100 }, { accountCode: '1010', credit: 100 }] })
      .expect(422);
    // an open period still accepts postings
    await request(app).post('/api/clients/esquina/entries').set(STAFF)
      .send({ date: '2026-07-05', memo: 'ok', source: 's', lines: [{ accountCode: '6000', debit: 100 }, { accountCode: '1010', credit: 100 }] })
      .expect(201);
    // unlock reopens it
    await request(app).post('/api/clients/esquina/periods/2026-06/unlock').set(KEY).expect(200);
    await request(app).post('/api/clients/esquina/entries').set(STAFF)
      .send({ date: '2026-06-21', memo: 'reopened', source: 's', lines: [{ accountCode: '6000', debit: 100 }, { accountCode: '1010', credit: 100 }] })
      .expect(201);
  });

  it('reports include a reconciling cash-flow statement', async () => {
    const r = await request(app).get('/api/clients/andina/reports').set(KEY).expect(200);
    expect(r.body.cashFlow).toBeTruthy();
    expect(r.body.cashFlow.reconciles).toBe(true);
    expect(r.body.cashFlow.netChange).toBe(
      r.body.cashFlow.operating + r.body.cashFlow.investing + r.body.cashFlow.financing);
  });

  it('creates a vendor bill that opens a payable and books proveedores', async () => {
    const r = await request(app).post('/api/clients/roble/bills').set(STAFF)
      .send({ vendorName: 'Distribuidora Norte', vendorNit: '830900', date: '2026-06-15', base: 1000000, expenseAccount: '1200' })
      .expect(201);
    // base 1,000,000 + VAT 150,000 (15%) = 1,150,000 payable (no KSA withholding)
    expect(r.body.item.kind).toBe('payable');
    expect(r.body.item.outstanding).toBe(1150000);
    const payables = (await request(app).get('/api/clients/roble/open-items?kind=payable').set(KEY)).body;
    expect(payables.some((i: { docNumber: string }) => i.docNumber === r.body.bill.number)).toBe(true);
  });

  it('records a partial payment that reduces the outstanding balance', async () => {
    // make a fresh bill, then pay part of it
    const bill = await request(app).post('/api/clients/roble/bills').set(STAFF)
      .send({ vendorName: 'Proveedor X', date: '2026-06-10', base: 1000000, applyRete: false }).expect(201);
    const id = bill.body.item.id;
    const before = bill.body.item.outstanding; // 1,150,000 (base + 15% VAT)
    const pay = await request(app).post('/api/clients/roble/payments').set(STAFF)
      .send({ openItemId: id, amount: 500000, date: '2026-06-20' }).expect(200);
    expect(pay.body.item.paid).toBe(500000);
    expect(pay.body.item.outstanding).toBe(before - 500000);
    // overpaying is rejected
    await request(app).post('/api/clients/roble/payments').set(STAFF)
      .send({ openItemId: id, amount: 99000000, date: '2026-06-21' }).expect(422);
  });

  it('an issued invoice opens a receivable that appears in AR aging', async () => {
    await request(app).post('/api/clients/roble/invoices').set(STAFF)
      .send({ client: 'Cliente Aging', date: '2026-05-01', base: 2000000 }).expect(201);
    // due 2026-05-31; as of 2026-06-30 it's ~30 days overdue
    const a = await request(app).get('/api/clients/roble/aging?kind=receivable&asOf=2026-06-30').set(KEY).expect(200);
    expect(a.body.total).toBeGreaterThan(0);
    expect(a.body.rows.some((r: { docNumber: string }) => /FE-/.test(r.docNumber))).toBe(true);
  });

  it('checklist: auto-evaluates trial balance and records a manual sign-off in the trail', async () => {
    const c1 = await request(app).get('/api/clients/roble/checklist?period=2026-06').set(KEY).expect(200);
    const tb = c1.body.items.find((i: { key: string }) => i.key === 'trial_balance');
    expect(tb.auto).toBe(true);
    expect(tb.done).toBe(true); // roble's books balance, so it's auto-satisfied
    // sign off a manual task
    await request(app).post('/api/clients/roble/checklist/bank_recs').set(KEY)
      .send({ period: '2026-06', done: true }).expect(200);
    const c2 = await request(app).get('/api/clients/roble/checklist?period=2026-06').set(KEY).expect(200);
    const rec = c2.body.items.find((i: { key: string }) => i.key === 'bank_recs');
    expect(rec.done).toBe(true);
    expect(rec.by).toBeTruthy();
    const audit = (await request(app).get('/api/clients/roble/audit').set(KEY)).body;
    expect(audit.events.some((e: { action: string }) => e.action === 'CHECKLIST_SIGNOFF')).toBe(true);
  });
});
