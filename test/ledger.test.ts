import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { MemoryRepository } from '../src/persistence/memoryRepo.js';
import { LedgerService } from '../src/services/ledgerService.js';
import { pesos } from '../src/domain/money.js';
import { trialBalance, rawBalances } from '../src/domain/reports.js';
import { CHART_OF_ACCOUNTS } from '../src/domain/accounts.js';
import { UnbalancedEntryError } from '../src/domain/journal.js';

const fixedClock = () => '2026-06-15T12:00:00.000Z';
const newLedger = () =>
  new LedgerService(new MemoryRepository(), {
    user: 'test',
    approvalThreshold: pesos(1_000_000),
    clock: fixedClock,
  });

const CODES = CHART_OF_ACCOUNTS.map((a) => a.code);

describe('ledger core — invariants', () => {
  it('rejects an entry that does not balance (nothing persisted)', async () => {
    const repo = new MemoryRepository();
    const ledger = new LedgerService(repo, { user: 't', approvalThreshold: pesos(1_000_000), clock: fixedClock });
    await expect(
      ledger.post({
        date: '2026-06-10', memo: 'bad', source: 'x', user: 't',
        lines: [{ accountCode: '1010', debit: pesos(100) }, { accountCode: '4000', credit: pesos(90) }],
      }),
    ).rejects.toBeInstanceOf(UnbalancedEntryError);
    expect((await repo.listEntries()).length).toBe(0);
  });

  it('PROPERTY: after any sequence of balanced postings, the trial balance sums to zero', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            drIdx: fc.integer({ min: 0, max: CODES.length - 1 }),
            crIdx: fc.integer({ min: 0, max: CODES.length - 1 }),
            amount: fc.integer({ min: 1, max: 5_000_000 }),
          }).filter((op) => op.drIdx !== op.crIdx),
          { minLength: 1, maxLength: 40 },
        ),
        async (ops) => {
          const repo = new MemoryRepository();
          const ledger = new LedgerService(repo, { user: 't', approvalThreshold: pesos(1_000_000), clock: fixedClock });
          for (const op of ops) {
            await ledger.post({
              date: '2026-06-10', memo: 'p', source: 's', user: 't',
              lines: [
                { accountCode: CODES[op.drIdx]!, debit: pesos(op.amount) },
                { accountCode: CODES[op.crIdx]!, credit: pesos(op.amount) },
              ],
            });
          }
          const entries = await repo.listEntries();
          const tb = trialBalance(entries);
          // invariant 1: debits == credits
          if (tb.totalDebit !== tb.totalCredit) return false;
          // invariant 2: raw balances across all accounts sum to exactly zero
          let sum = 0n;
          for (const v of rawBalances(entries).values()) sum += v;
          return sum === 0n && tb.balanced;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('entries are immutable: the same id cannot be saved twice', async () => {
    const repo = new MemoryRepository();
    const e = {
      id: 'AS-0001', date: '2026-06-01', memo: 'm', source: 's', user: 'u',
      reversed: false, recordedAt: fixedClock(),
      lines: [{ accountCode: '1010', debit: pesos(10), credit: 0n }, { accountCode: '3000', debit: 0n, credit: pesos(10) }],
    };
    await repo.saveEntry(e);
    await expect(repo.saveEntry(e)).rejects.toThrow(/inmutable/);
  });

  it('reversal posts an opposite entry and keeps the original (append-only)', async () => {
    const repo = new MemoryRepository();
    const ledger = new LedgerService(repo, { user: 't', approvalThreshold: pesos(1_000_000), clock: fixedClock });
    const { entry } = await ledger.post({
      date: '2026-06-10', memo: 'venta', source: 'ACME', user: 't',
      lines: [{ accountCode: '1010', debit: pesos(500) }, { accountCode: '4000', credit: pesos(500) }],
    });
    await ledger.reverse(entry.id, 'error de digitación');
    const entries = await repo.listEntries();
    expect(entries.length).toBe(2); // original + reversal, nothing deleted
    const original = entries.find((x) => x.id === entry.id)!;
    expect(original.reversed).toBe(true);
    // net effect on the books is zero after reversal
    const tb = trialBalance(entries);
    expect(tb.balanced).toBe(true);
    expect(rawBalances(entries).get('4000')).toBe(0n);
  });
});
