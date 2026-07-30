/**
 * Repository backed by in-memory maps, optionally persisted to a JSON file.
 * Enforces the same append-only discipline the Postgres schema enforces at the
 * DB layer: saveEntry refuses to overwrite an existing entry id.
 *
 * Pass a `persistFile` to make a client's books durable across restarts — the
 * five collections are flushed to disk (bigint-safe) after every mutation and
 * reloaded on construction.
 */

import { Repository, EInvoiceRecord } from './repository.js';
import { JournalEntry } from '../domain/journal.js';
import { AuditEvent } from '../domain/auditTrail.js';
import { Finding, FindingStatus } from '../domain/findings.js';
import { WorkingPaper } from '../domain/workingPapers.js';
import { readJson, writeJson } from './store.js';

interface Snapshot {
  entries: JournalEntry[];
  audit: AuditEvent[];
  findings: Finding[];
  invoices: EInvoiceRecord[];
  workingPapers: WorkingPaper[];
}

export class MemoryRepository implements Repository {
  private entries = new Map<string, JournalEntry>();
  private audit: AuditEvent[] = [];
  private findings = new Map<string, Finding>();
  private invoices: EInvoiceRecord[] = [];
  private workingPapers = new Map<string, WorkingPaper>();

  constructor(private readonly persistFile?: string) {
    if (this.persistFile) {
      const s = readJson<Snapshot | null>(this.persistFile, null);
      if (s) {
        for (const e of s.entries ?? []) this.entries.set(e.id, e);
        this.audit = s.audit ?? [];
        for (const f of s.findings ?? []) this.findings.set(f.id, f);
        this.invoices = s.invoices ?? [];
        for (const w of s.workingPapers ?? []) this.workingPapers.set(w.id, w);
      }
    }
  }

  private flush(): void {
    if (!this.persistFile) return;
    writeJson(this.persistFile, {
      entries: [...this.entries.values()],
      audit: this.audit,
      findings: [...this.findings.values()],
      invoices: this.invoices,
      workingPapers: [...this.workingPapers.values()],
    } satisfies Snapshot);
  }

  /** True when this repo has no data yet (used to decide whether to seed). */
  isEmpty(): boolean {
    return this.entries.size === 0 && this.audit.length === 0 && this.invoices.length === 0;
  }

  async saveEntry(e: JournalEntry): Promise<void> {
    if (this.entries.has(e.id)) {
      throw new Error(`Entry ${e.id} is immutable — it already exists and cannot be modified.`);
    }
    this.entries.set(e.id, structuredClone(e));
    this.flush();
  }

  async markReversed(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Entry not found: ${id}`);
    e.reversed = true;
    this.flush();
  }

  async listEntries(): Promise<JournalEntry[]> {
    return [...this.entries.values()].map((e) => structuredClone(e));
  }

  async appendAudit(e: AuditEvent): Promise<void> {
    this.audit.push(structuredClone(e));
    this.flush();
  }
  async listAudit(): Promise<AuditEvent[]> {
    return this.audit.map((e) => structuredClone(e));
  }

  async saveFinding(f: Finding): Promise<void> {
    this.findings.set(f.id, structuredClone(f));
    this.flush();
  }
  async updateFindingStatus(id: string, status: FindingStatus, by: string, note?: string): Promise<void> {
    const f = this.findings.get(id);
    if (!f) throw new Error(`Finding not found: ${id}`);
    f.status = status;
    f.resolvedBy = by;
    if (note !== undefined) f.resolutionNote = note;
    this.flush();
  }
  async listFindings(): Promise<Finding[]> {
    return [...this.findings.values()].map((f) => structuredClone(f));
  }

  async saveInvoice(r: EInvoiceRecord): Promise<void> {
    this.invoices.push(structuredClone(r));
    this.flush();
  }
  async listInvoices(): Promise<EInvoiceRecord[]> {
    return this.invoices.map((r) => structuredClone(r));
  }

  async saveWorkingPaper(wp: WorkingPaper): Promise<void> {
    this.workingPapers.set(wp.id, structuredClone(wp));
    this.flush();
  }
  async listWorkingPapers(): Promise<WorkingPaper[]> {
    return [...this.workingPapers.values()].map((wp) => structuredClone(wp));
  }
}
