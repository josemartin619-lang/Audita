import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/api/server.js';
import { seedFirm } from '../src/api/seed.js';

let app: Express;
const KEY = { 'x-api-key': 'dev-key' };

beforeAll(async () => {
  app = createApp(await seedFirm());
});

describe('REST API', () => {
  it('rejects requests without the API key', async () => {
    await request(app).get('/api/clients').expect(401);
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
      .send({ date: '2026-06-20', memo: 'ok', source: 's', lines: [{ accountCode: '111005', debit: 100 }, { accountCode: '413505', credit: 100 }] })
      .expect(201);
    await request(app).post('/api/clients/roble/entries').set(KEY)
      .send({ date: '2026-06-20', memo: 'bad', source: 's', lines: [{ accountCode: '111005', debit: 100 }, { accountCode: '413505', credit: 90 }] })
      .expect(422);
  });

  it('serves the chart of accounts for the entry form', async () => {
    const r = await request(app).get('/api/accounts').set(KEY).expect(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.find((a: { code: string }) => a.code === '413505')).toBeTruthy();
  });

  it('issues an invoice with a CUFE', async () => {
    const r = await request(app).post('/api/clients/roble/invoices').set(KEY)
      .send({ client: 'Nuevo Cliente', date: '2026-06-21', base: 1000000 }).expect(201);
    expect(r.body.cufe).toMatch(/^[0-9a-f]{96}$/);
  });

  it('verifies the audit chain is valid via the API', async () => {
    const r = await request(app).get('/api/clients/andina/audit').set(KEY).expect(200);
    expect(r.body.verification.valid).toBe(true);
  });

  it('updates a finding status', async () => {
    const findings = (await request(app).get('/api/clients/andina/findings').set(KEY)).body;
    const open = findings.find((f: { status: string }) => f.status === 'open');
    await request(app).post(`/api/clients/andina/findings/${open.id}/status`).set(KEY)
      .send({ status: 'cleared', note: 'soporte verificado' }).expect(200);
    const after = (await request(app).get('/api/clients/andina/findings').set(KEY)).body;
    expect(after.find((f: { id: string }) => f.id === open.id).status).toBe('cleared');
  });
});
