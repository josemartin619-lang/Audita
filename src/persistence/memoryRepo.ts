/**
 * In-memory repository. Used by tests and the demo. Enforces the same
 * append-only discipline the Postgres schema enforces at the DB layer:
 * saveEntry refuses to overwrite an existing entry id.
 */

import { Repository, EInvoiceRecord } from './repository.js';
import { JournalEntry } from '../domain/journal.js';
import { AuditEvent } from '../domain/auditTrail.js';
import { Finding, FindingStatus } from '../domain/findings.js';
import { WorkingPaper } from '../domain/workingPapers.js';

export class MemoryRepository implements Repository {
  private entries = new Map<string, JournalEntry>();
  private audit: AuditEvent[] = [];
  private findings = new Map<string, Finding>();
  private invoices: EInvoiceRecord[] = [];
  private workingPapers = new Map<string, WorkingPaper>();

  async saveEntry(e: JournalEntry): Promise<void> {
    if (this.entries.has(e.id)) {
      throw new Error(`Asiento inmutable: ${e.id} ya existe y no puede modificarse.`);
    }
    this.entries.set(e.id, structuredClone(e));
  }

  async markReversed(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Asiento no encontrado: ${id}`);
    e.reversed = true;
  }

  async listEntries(): Promise<JournalEntry[]> {
    return [...this.entries.values()].map((e) => structuredClone(e));
  }

  async appendAudit(e: AuditEvent): Promise<void> {
    this.audit.push(structuredClone(e));
  }
  async listAudit(): Promise<AuditEvent[]> {
    return this.audit.map((e) => structuredClone(e));
  }

  async saveFinding(f: Finding): Promise<void> {
    this.findings.set(f.id, structuredClone(f));
  }
  async updateFindingStatus(id: string, status: FindingStatus, by: string, note?: string): Promise<void> {
    const f = this.findings.get(id);
    if (!f) throw new Error(`Hallazgo no encontrado: ${id}`);
    f.status = status;
    f.resolvedBy = by;
    if (note !== undefined) f.resolutionNote = note;
  }
  async listFindings(): Promise<Finding[]> {
    return [...this.findings.values()].map((f) => structuredClone(f));
  }

  async saveInvoice(r: EInvoiceRecord): Promise<void> {
    this.invoices.push(structuredClone(r));
  }
  async listInvoices(): Promise<EInvoiceRecord[]> {
    return this.invoices.map((r) => structuredClone(r));
  }

  async saveWorkingPaper(wp: WorkingPaper): Promise<void> {
    this.workingPapers.set(wp.id, structuredClone(wp));
  }
  async listWorkingPapers(): Promise<WorkingPaper[]> {
    return [...this.workingPapers.values()].map((wp) => structuredClone(wp));
  }
}
