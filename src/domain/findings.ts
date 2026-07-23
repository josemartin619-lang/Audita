/**
 * Findings — the managed output of continuous controls. Each flagged anomaly
 * becomes a finding with a lifecycle an auditor works through. This is the
 * raw material of an audit, generated automatically at post time.
 */

export type Severity = 'low' | 'medium' | 'high';

export type FindingStatus =
  | 'open'
  | 'reviewed'
  | 'cleared'
  | 'escalated';

export interface Finding {
  id: string;
  rule: string;
  severity: Severity;
  /** Entry the finding is about ('—' for cross-entry findings like sequence gaps). */
  entryId: string;
  message: string;
  status: FindingStatus;
  raisedAt: string;
  /** Set when a reviewer changes status. */
  resolvedBy?: string;
  resolutionNote?: string;
}

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  low: 1,
  medium: 3,
  high: 8,
};

export const OPEN_STATUSES: FindingStatus[] = ['open', 'escalated'];

export function isOpen(f: Finding): boolean {
  return OPEN_STATUSES.includes(f.status);
}
