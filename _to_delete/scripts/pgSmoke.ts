/**
 * Integration smoke: drive the real PostgresRepository (not the in-memory one)
 * through LedgerService + InvoiceService against a live database, then read
 * everything back and assert the invariants survive a full round-trip.
 *
 *   DATABASE_URL=postgres://audita@localhost:5433/audita npx tsx scripts/pgSmoke.ts
 */

import pg from 'pg';
import { PostgresRepository } from '../src/persistence/pg/pgRepo.js';
import { LedgerService } from '../src/services/ledgerService.js';
import { InvoiceService } from '../src/services/invoiceService.js';
import { SandboxEInvoicingProvider } from '../src/einvoicing/sandboxProvider.js';
import { pesos, formatCOP } from '../src/domain/money.js';
import { trialBalance } from '../src/domain/reports.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL');
  process.exit(1);
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('  ✓ ' + msg);
}

async function main() {
  const pool = new pg.Pool({ connectionString: url });
  const repo = new PostgresRepository(pool);
  const ledger = new LedgerService(repo, { user: 'pg-smoke', approvalThreshold: pesos(1_000_000) });
  const invoices = new InvoiceService(repo, ledger, new SandboxEInvoicingProvider());

  console.log('Posting through PostgresRepository...');
  await ledger.post({
    date: '2026-06-01', memo: 'capital', source: 'Socios', user: 'pg-smoke',
    lines: [{ accountCode: '111005', debit: pesos(20_000_000) }, { accountCode: '310505', credit: pesos(20_000_000) }],
  });
  const inv = await invoices.issue({ client: 'Cliente PG', acquirerId: '830999', date: '2026-06-05', concept: 'Venta', base: pesos(3_000_000), ofeNit: '900123456' });
  console.log('  issued', inv.number, 'CUFE', inv.cufe.slice(0, 16) + '…');

  // Read back from the DB and verify.
  const entries = await repo.listEntries();
  assert(entries.length === 2, 'two entries persisted and read back');
  const tb = trialBalance(entries);
  assert(tb.balanced, `trial balance ties after DB round-trip (${formatCOP(tb.totalDebit)})`);

  const audit = await repo.listAudit();
  assert(audit.length >= 3, `audit events persisted (${audit.length})`);
  assert(audit[0]!.prevHash === 'GENESIS', 'audit chain starts at GENESIS in DB');

  const storedInvoices = await repo.listInvoices();
  assert(storedInvoices.length === 1 && storedInvoices[0]!.cufe === inv.cufe, 'invoice + CUFE persisted');

  // Immutability enforced by the DB: attempt a raw UPDATE, expect rejection.
  let blocked = false;
  try {
    await pool.query(`UPDATE journal_line SET debit = 1 WHERE entry_id = $1`, [entries[0]!.id]);
  } catch {
    blocked = true;
  }
  assert(blocked, 'DB trigger blocks UPDATE of a posted line (immutability)');

  await pool.end();
  console.log('\nPG SMOKE PASSED ✓');
}

main().catch((e) => { console.error(e); process.exit(1); });
