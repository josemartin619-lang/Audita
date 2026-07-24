/**
 * Working papers — native to the ledger, not a separate CaseWare file. A
 * working paper ties a booked account balance to independent supporting
 * evidence and records the preparer/reviewer sign-off. The close package
 * bundles them into the audit file.
 */

import { Money, ZERO, abs } from './money.js';
import { JournalEntry } from './journal.js';
import { naturalBalance } from './reports.js';
import { getAccount } from './accounts.js';

export type WorkingPaperStatus = 'draft' | 'prepared' | 'reviewed' | 'signed_off';

export interface WorkingPaper {
  id: string;
  accountCode: string;
  period: string; // e.g. "2026-06"
  /** Balance per the books (natural side). */
  bookedBalance: Money;
  /** Balance per external support (bank cert, inventory count, confirmation). */
  supportBalance: Money;
  /** bookedBalance - supportBalance. Non-zero = a tie-out difference. */
  difference: Money;
  status: WorkingPaperStatus;
  preparedBy?: string;
  reviewedBy?: string;
  notes: string;
  createdAt: string;
}

export function buildWorkingPaper(input: {
  id: string;
  accountCode: string;
  period: string;
  entries: readonly JournalEntry[];
  supportBalance: Money;
  preparedBy: string;
  notes?: string;
  createdAt: string;
}): WorkingPaper {
  getAccount(input.accountCode); // validate account exists
  const booked = naturalBalance(input.accountCode, input.entries);
  return {
    id: input.id,
    accountCode: input.accountCode,
    period: input.period,
    bookedBalance: booked,
    supportBalance: input.supportBalance,
    difference: booked - input.supportBalance,
    status: 'prepared',
    preparedBy: input.preparedBy,
    notes: input.notes ?? '',
    createdAt: input.createdAt,
  };
}

export function isTiedOut(wp: WorkingPaper): boolean {
  return wp.difference === ZERO;
}

export interface ClosePackage {
  period: string;
  generatedAt: string;
  trialBalanceBalanced: boolean;
  auditTrailValid: boolean;
  openFindings: number;
  workingPapers: WorkingPaper[];
  untiedPapers: WorkingPaper[];
  /** Close is blocked when the books don't balance, the trail is broken,
   *  there are open high-severity findings, or a working paper doesn't tie. */
  readyToClose: boolean;
  blockers: string[];
}

export function assembleClosePackage(input: {
  period: string;
  generatedAt: string;
  trialBalanceBalanced: boolean;
  auditTrailValid: boolean;
  openHighFindings: number;
  openFindings: number;
  workingPapers: WorkingPaper[];
}): ClosePackage {
  const untied = input.workingPapers.filter((wp) => abs(wp.difference) !== ZERO);
  const blockers: string[] = [];
  if (!input.trialBalanceBalanced) blockers.push('Trial balance does not tie.');
  if (!input.auditTrailValid) blockers.push('The evidence trail is broken (possible tampering).');
  if (input.openHighFindings > 0)
    blockers.push(`${input.openHighFindings} unresolved high-severity finding(s).`);
  if (untied.length > 0)
    blockers.push(`${untied.length} working paper(s) not tied out (tie-out ≠ 0).`);
  return {
    period: input.period,
    generatedAt: input.generatedAt,
    trialBalanceBalanced: input.trialBalanceBalanced,
    auditTrailValid: input.auditTrailValid,
    openFindings: input.openFindings,
    workingPapers: input.workingPapers,
    untiedPapers: untied,
    readyToClose: blockers.length === 0,
    blockers,
  };
}
