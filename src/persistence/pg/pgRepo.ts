/**
 * PostgresRepository — production persistence. Implements the same Repository
 * interface as MemoryRepository, so the domain is unchanged. Money round-trips
 * as BIGINT centavos <-> bigint. Requires the schema in schema.sql.
 *
 * Not exercised by the test suite (which runs DB-free against MemoryRepository);
 * wire it up with a real DATABASE_URL. Kept intentionally simple and explicit.
 */

import type { Pool } from 'pg';
import { Repository, EInvoiceRecord } from '../repository.js';
import { JournalEntry } from '../../domain/journal.js';
import { AuditEvent, AuditAction } from '../../domain/auditTrail.js';
import { Finding, FindingStatus, Severity } from '../../domain/findings.js';
import { WorkingPaper, WorkingPaperStatus } from '../../domain/workingPapers.js';

export class PostgresRepository implements Repository {
  constructor(private readonly pool: Pool) {}

  async saveEntry(e: JournalEntry): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query(
        `INSERT INTO journal_entry (id, entry_date, memo, source, app_user, source_document, reversed, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [e.id, e.date, e.memo, e.source, e.user, e.sourceDocument ?? null, e.reversed, e.recordedAt],
      );
      let lineNo = 0;
      for (const l of e.lines) {
        await client.query(
          `INSERT INTO journal_line (entry_id, line_no, account_code, debit, credit)
           VALUES ($1,$2,$3,$4,$5)`,
          [e.id, lineNo++, l.accountCode, l.debit.toString(), l.credit.toString()],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async markReversed(id: string): Promise<void> {
    await this.pool.query('UPDATE journal_entry SET reversed = TRUE WHERE id = $1', [id]);
  }

  async listEntries(): Promise<JournalEntry[]> {
    const entries = await this.pool.query(
      `SELECT id, entry_date, memo, source, app_user, source_document, reversed, recorded_at
       FROM journal_entry ORDER BY recorded_at, id`,
    );
    const lines = await this.pool.query(
      `SELECT entry_id, account_code, debit, credit FROM journal_line ORDER BY entry_id, line_no`,
    );
    const byEntry = new Map<string, JournalEntry>();
    for (const r of entries.rows) {
      byEntry.set(r.id, {
        id: r.id,
        date: typeof r.entry_date === 'string' ? r.entry_date : r.entry_date.toISOString().slice(0, 10),
        memo: r.memo,
        source: r.source,
        user: r.app_user,
        sourceDocument: r.source_document ?? undefined,
        reversed: r.reversed,
        recordedAt: new Date(r.recorded_at).toISOString(),
        lines: [],
      });
    }
    for (const l of lines.rows) {
      byEntry.get(l.entry_id)?.lines.push({
        accountCode: l.account_code,
        debit: BigInt(l.debit),
        credit: BigInt(l.credit),
      });
    }
    return [...byEntry.values()];
  }

  async appendAudit(e: AuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_event (seq, action, ref, detail, app_user, ts, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [e.seq, e.action, e.ref, JSON.stringify(e.detail), e.user, e.ts, e.prevHash, e.hash],
    );
  }

  async listAudit(): Promise<AuditEvent[]> {
    const r = await this.pool.query(`SELECT * FROM audit_event ORDER BY seq`);
    return r.rows.map((x) => ({
      seq: x.seq,
      action: x.action as AuditAction,
      ref: x.ref,
      detail: x.detail,
      user: x.app_user,
      ts: new Date(x.ts).toISOString(),
      prevHash: x.prev_hash,
      hash: x.hash,
    }));
  }

  async saveFinding(f: Finding): Promise<void> {
    await this.pool.query(
      `INSERT INTO finding (id, rule, severity, entry_id, message, status, raised_at, resolved_by, resolution_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [f.id, f.rule, f.severity, f.entryId, f.message, f.status, f.raisedAt, f.resolvedBy ?? null, f.resolutionNote ?? null],
    );
  }

  async updateFindingStatus(id: string, status: FindingStatus, by: string, note?: string): Promise<void> {
    await this.pool.query(
      `UPDATE finding SET status=$2, resolved_by=$3, resolution_note=$4 WHERE id=$1`,
      [id, status, by, note ?? null],
    );
  }

  async listFindings(): Promise<Finding[]> {
    const r = await this.pool.query(`SELECT * FROM finding ORDER BY id`);
    return r.rows.map((x) => ({
      id: x.id,
      rule: x.rule,
      severity: x.severity as Severity,
      entryId: x.entry_id,
      message: x.message,
      status: x.status as FindingStatus,
      raisedAt: new Date(x.raised_at).toISOString(),
      resolvedBy: x.resolved_by ?? undefined,
      resolutionNote: x.resolution_note ?? undefined,
    }));
  }

  async saveInvoice(r: EInvoiceRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO einvoice (number, client, inv_date, cufe, status, entry_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [r.number, r.client, r.date, r.cufe, r.status, r.entryId],
    );
  }

  async listInvoices(): Promise<EInvoiceRecord[]> {
    const r = await this.pool.query(`SELECT * FROM einvoice ORDER BY number`);
    return r.rows.map((x) => ({
      number: x.number,
      client: x.client,
      date: typeof x.inv_date === 'string' ? x.inv_date : x.inv_date.toISOString().slice(0, 10),
      cufe: x.cufe,
      status: x.status,
      entryId: x.entry_id,
    }));
  }

  async saveWorkingPaper(wp: WorkingPaper): Promise<void> {
    await this.pool.query(
      `INSERT INTO working_paper (id, account_code, period, booked_balance, support_balance, difference, status, prepared_by, reviewed_by, notes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [wp.id, wp.accountCode, wp.period, wp.bookedBalance.toString(), wp.supportBalance.toString(),
       wp.difference.toString(), wp.status, wp.preparedBy ?? null, wp.reviewedBy ?? null, wp.notes, wp.createdAt],
    );
  }

  async listWorkingPapers(): Promise<WorkingPaper[]> {
    const r = await this.pool.query(`SELECT * FROM working_paper ORDER BY id`);
    return r.rows.map((x) => ({
      id: x.id,
      accountCode: x.account_code,
      period: x.period,
      bookedBalance: BigInt(x.booked_balance),
      supportBalance: BigInt(x.support_balance),
      difference: BigInt(x.difference),
      status: x.status as WorkingPaperStatus,
      preparedBy: x.prepared_by ?? undefined,
      reviewedBy: x.reviewed_by ?? undefined,
      notes: x.notes,
      createdAt: new Date(x.created_at).toISOString(),
    }));
  }
}
