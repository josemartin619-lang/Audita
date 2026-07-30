/**
 * Restart / cold-start durability.
 *
 * Every service in this app keeps its id counters and the audit chain in memory.
 * A second process opened over the SAME repository therefore starts at zero and
 * collides with stored ids — the first posting after any restart failed with
 * "Entry AS-0001 is immutable". On Vercel a cold start happens routinely, so the
 * bug is not an edge case there, it is the normal path.
 *
 * These tests simulate a restart the only way that proves anything: throw the
 * services away and build new ones over the same repository.
 */

import { describe, it, expect } from 'vitest';
import { FirmWorkspace } from '../src/services/firmWorkspace.js';
import { MemoryRepository } from '../src/persistence/memoryRepo.js';
import { pesos } from '../src/domain/money.js';
import type { Repository } from '../src/persistence/repository.js';
import { highestSeq } from '../src/services/seq.js';

const clock = () => '2026-06-15T12:00:00.000Z';
const META = { clientId: 'c1', name: 'C1', ofeNit: '900' };

/** One repository shared across two "processes". */
function firmOver(repo: Repository): FirmWorkspace {
  return new FirmWorkspace({
    user: 'f',
    approvalThreshold: pesos(1_000_000),
    clock,
    repoFactory: () => repo,
  });
}

const line = (n: number) => [
  { accountCode: '1010', debit: pesos(n) },
  { accountCode: '4000', credit: pesos(n) },
];

describe('sequence recovery', () => {
  it('reads the watermark from stored ids and ignores foreign prefixes', () => {
    expect(highestSeq(['AS-0001', 'AS-0012', 'AS-0007'], 'AS-')).toBe(12);
    expect(highestSeq(['FE-0003', 'AS-0099'], 'FE-')).toBe(3);
    expect(highestSeq([], 'AS-')).toBe(0);
    expect(highestSeq(['nonsense', 'AS-xx'], 'AS-')).toBe(0);
  });
});

describe('restart over existing books', () => {
  it('can post again after a restart (no id collision)', async () => {
    const repo = new MemoryRepository();

    const first = firmOver(repo);
    const a = first.addClient(META);
    await a.ledger.post({ date: '2026-06-10', memo: 'before restart', source: 's', user: 'f', lines: line(1_000) });
    const idsBefore = (await repo.listEntries()).map((e) => e.id);
    expect(idsBefore).toEqual(['AS-0001']);

    // --- restart: brand-new services over the same repository ---
    const second = firmOver(repo);
    const b = second.addClient(META);
    await second.resumeAll();

    await expect(
      b.ledger.post({ date: '2026-06-11', memo: 'after restart', source: 's', user: 'f', lines: line(2_000) }),
    ).resolves.toBeTruthy();

    const ids = (await repo.listEntries()).map((e) => e.id);
    expect(ids).toEqual(['AS-0001', 'AS-0002']);
  });

  it('keeps the audit chain valid across a restart instead of forking it', async () => {
    const repo = new MemoryRepository();

    const first = firmOver(repo);
    const a = first.addClient(META);
    await a.ledger.post({ date: '2026-06-10', memo: 'one', source: 's', user: 'f', lines: line(1_000) });

    const second = firmOver(repo);
    const b = second.addClient(META);
    await second.resumeAll();
    await b.ledger.post({ date: '2026-06-11', memo: 'two', source: 's', user: 'f', lines: line(2_000) });

    // Sequence numbers must not repeat, and the chain must still verify.
    const stored = await repo.listAudit();
    const seqs = stored.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(b.ledger.auditTrail().verify()).toEqual({ valid: true });
  });

  it('does not re-issue an invoice number after a restart', async () => {
    const repo = new MemoryRepository();

    const first = firmOver(repo);
    const a = first.addClient(META);
    await a.invoices.issue({ client: 'Cust', acquirerId: '900', ofeNit: META.ofeNit, date: '2026-06-10', concept: 'x', base: pesos(100_000) });

    const second = firmOver(repo);
    const b = second.addClient(META);
    await second.resumeAll();
    await b.invoices.issue({ client: 'Cust', acquirerId: '900', ofeNit: META.ofeNit, date: '2026-06-11', concept: 'y', base: pesos(100_000) });

    const numbers = (await repo.listInvoices()).map((i) => i.number);
    expect(numbers).toEqual(['FE-0001', 'FE-0002']);
  });

  it('restores closed periods, so a signed-off month stays closed', async () => {
    const repo = new MemoryRepository();

    const first = firmOver(repo);
    const a = first.addClient(META);
    a.ledger.lockPeriod('2026-05');
    const persisted = { [META.clientId]: a.ledger.lockedPeriods() };

    const second = firmOver(repo);
    const b = second.addClient(META);
    await second.resumeAll(persisted);

    expect(b.ledger.isPeriodLocked('2026-05')).toBe(true);
    await expect(
      b.ledger.post({ date: '2026-05-20', memo: 'back-dated', source: 's', user: 'f', lines: line(500) }),
    ).rejects.toThrow(/closed/i);
  });
});

describe('advisory controls', () => {
  it('reports a posted entry as posted even if the control pass blows up', async () => {
    const repo = new MemoryRepository();
    const firm = firmOver(repo);
    const c = firm.addClient(META);
    // Break the control pass from the outside: listEntries is what runControls
    // reads, and a repository failure there must not undo an accepted posting.
    const real = repo.listEntries.bind(repo);
    let armed = true;
    repo.listEntries = async () => {
      if (armed) throw new Error('boom');
      return real();
    };

    const res = await c.ledger.post({ date: '2026-06-10', memo: 'x', source: 's', user: 'f', lines: line(1_000) });
    armed = false;
    repo.listEntries = real;

    expect(res.entry.id).toBe('AS-0001');
    expect(res.findings.some((f) => f.rule === 'Control pass failed')).toBe(true);
    expect((await repo.listEntries()).length).toBe(1);
  });
});
