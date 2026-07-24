/**
 * LedgerService — the posting engine. It is the ONLY way entries enter the
 * ledger, so it can guarantee, atomically, that every posting:
 *   1. balances (double-entry),
 *   2. is written append-only,
 *   3. is recorded in the immutable audit trail,
 *   4. is run through continuous controls, raising findings.
 *
 * Everything else in the product calls into this. That is what lets the rest
 * of the system be built quickly and safely: the money path is a fortress.
 */

import { Money } from '../domain/money.js';
import {
  DraftEntry,
  JournalEntry,
  normalizeLines,
  reversingLines,
  entryAmount,
} from '../domain/journal.js';
import { AuditTrail } from '../domain/auditTrail.js';
import { Finding, FindingStatus } from '../domain/findings.js';
import { runPerEntryRules, RuleHit } from '../domain/controls/rules.js';
import { Repository } from '../persistence/repository.js';
import { Jurisdiction } from '../domain/jurisdiction.js';
import { COLOMBIA } from '../domain/jurisdictions/colombia.js';

export interface LedgerOptions {
  user: string;
  approvalThreshold: Money;
  /** Related-party watchlist passed to the controls. */
  relatedParties?: readonly string[];
  /** Injectable clock for deterministic tests. */
  clock?: () => string;
  /** Defaults to Colombia — the original, fully-tested jurisdiction. */
  jurisdiction?: Jurisdiction;
}

export interface PostResult {
  entry: JournalEntry;
  findings: Finding[];
}

export class LedgerService {
  private readonly trail = new AuditTrail();
  private entrySeq = 0;
  private findSeq = 0;
  private readonly clock: () => string;
  private readonly jurisdiction: Jurisdiction;

  constructor(private readonly repo: Repository, private readonly opts: LedgerOptions) {
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.jurisdiction = opts.jurisdiction ?? COLOMBIA;
  }

  auditTrail(): AuditTrail {
    return this.trail;
  }

  private nextEntryId(): string {
    this.entrySeq += 1;
    return `AS-${String(this.entrySeq).padStart(4, '0')}`;
  }
  private nextFindingId(): string {
    this.findSeq += 1;
    return `H-${String(this.findSeq).padStart(3, '0')}`;
  }

  /** Post a draft. Throws (nothing persisted) if it does not balance. */
  async post(draft: DraftEntry): Promise<PostResult> {
    const lines = normalizeLines(draft.lines, this.jurisdiction); // throws UnbalancedEntryError / unknown-account
    const ts = this.clock();
    const entry: JournalEntry = {
      id: this.nextEntryId(),
      date: draft.date,
      memo: draft.memo,
      source: draft.source,
      user: draft.user,
      lines,
      reversed: false,
      recordedAt: ts,
      sourceDocument: draft.sourceDocument,
    };
    await this.repo.saveEntry(entry);
    const ev = this.trail.append({
      action: 'POST_ENTRY',
      ref: entry.id,
      detail: {
        date: entry.date,
        memo: entry.memo,
        source: entry.source,
        amount: entryAmount(entry).toString(),
        sourceDocument: entry.sourceDocument ?? null,
      },
      user: entry.user,
      ts,
    });
    await this.repo.appendAudit(ev);

    const findings = await this.runControls(entry, ts);
    return { entry, findings };
  }

  private async runControls(entry: JournalEntry, ts: string): Promise<Finding[]> {
    const priorEntries = await this.repo.listEntries();
    const hits: RuleHit[] = runPerEntryRules(entry, {
      priorEntries,
      approvalThreshold: this.opts.approvalThreshold,
      relatedParties: this.opts.relatedParties,
      jurisdiction: this.jurisdiction,
    });
    const findings: Finding[] = [];
    for (const hit of hits) {
      const finding: Finding = {
        id: this.nextFindingId(),
        rule: hit.rule,
        severity: hit.severity,
        entryId: hit.entryId,
        message: hit.message,
        status: 'open',
        raisedAt: ts,
      };
      await this.repo.saveFinding(finding);
      const ev = this.trail.append({
        action: 'RAISE_FINDING',
        ref: finding.id,
        detail: { rule: finding.rule, severity: finding.severity, entryId: finding.entryId },
        user: 'system',
        ts,
      });
      await this.repo.appendAudit(ev);
      findings.push(finding);
    }
    return findings;
  }

  /** Raise a cross-entry finding (e.g. invoice sequence gap) explicitly. */
  async raiseFinding(hit: RuleHit): Promise<Finding> {
    const ts = this.clock();
    const finding: Finding = {
      id: this.nextFindingId(),
      rule: hit.rule,
      severity: hit.severity,
      entryId: hit.entryId,
      message: hit.message,
      status: 'open',
      raisedAt: ts,
    };
    await this.repo.saveFinding(finding);
    const ev = this.trail.append({
      action: 'RAISE_FINDING',
      ref: finding.id,
      detail: { rule: finding.rule, severity: finding.severity },
      user: 'system',
      ts,
    });
    await this.repo.appendAudit(ev);
    return finding;
  }

  async setFindingStatus(id: string, status: FindingStatus, note?: string): Promise<void> {
    await this.repo.updateFindingStatus(id, status, this.opts.user, note);
    const ev = this.trail.append({
      action: 'FINDING_STATUS',
      ref: id,
      detail: { status, note: note ?? null },
      user: this.opts.user,
      ts: this.clock(),
    });
    await this.repo.appendAudit(ev);
  }

  /**
   * Reverse an entry. The original is NEVER edited or deleted — a new,
   * opposite entry is posted and the original is flagged reversed. Both remain
   * permanently in the evidence chain.
   */
  async reverse(id: string, reason: string): Promise<PostResult> {
    const all = await this.repo.listEntries();
    const original = all.find((e) => e.id === id);
    if (!original) throw new Error(`Asiento no encontrado: ${id}`);
    if (original.reversed) throw new Error(`El asiento ${id} ya fue reversado.`);
    const ts = this.clock();
    await this.repo.markReversed(id);
    const revEv = this.trail.append({
      action: 'REVERSE_ENTRY',
      ref: id,
      detail: { reason },
      user: this.opts.user,
      ts,
    });
    await this.repo.appendAudit(revEv);
    return this.post({
      date: original.date,
      memo: `Reversión de ${id}: ${reason}`,
      source: original.source,
      user: this.opts.user,
      lines: reversingLines(original).map((l) => ({
        accountCode: l.accountCode,
        debit: l.debit,
        credit: l.credit,
      })),
      sourceDocument: id,
    });
  }
}
