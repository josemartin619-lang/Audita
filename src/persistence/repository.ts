/**
 * Repository interface — the ledger core is storage-agnostic. Tests run against
 * the in-memory implementation (fast, no DB); production uses the Postgres one.
 * Same interface, so the domain never knows or cares which is behind it.
 */

import { JournalEntry } from '../domain/journal.js';
import { AuditEvent } from '../domain/auditTrail.js';
import { Finding, FindingStatus } from '../domain/findings.js';
import { WorkingPaper } from '../domain/workingPapers.js';

export interface EInvoiceRecord {
  number: string;
  client: string;
  date: string;
  cufe: string;
  status: string;
  entryId: string;
}

export interface Repository {
  // journal (append-only; entries are never mutated except the reversed flag)
  saveEntry(e: JournalEntry): Promise<void>;
  markReversed(id: string): Promise<void>;
  listEntries(): Promise<JournalEntry[]>;

  // audit trail
  appendAudit(e: AuditEvent): Promise<void>;
  listAudit(): Promise<AuditEvent[]>;

  // findings
  saveFinding(f: Finding): Promise<void>;
  updateFindingStatus(id: string, status: FindingStatus, by: string, note?: string): Promise<void>;
  listFindings(): Promise<Finding[]>;

  // e-invoices
  saveInvoice(r: EInvoiceRecord): Promise<void>;
  listInvoices(): Promise<EInvoiceRecord[]>;

  // working papers
  saveWorkingPaper(wp: WorkingPaper): Promise<void>;
  listWorkingPapers(): Promise<WorkingPaper[]>;
}
