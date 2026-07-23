/**
 * Risk scoring — turns findings and posting patterns into a 0..100 score per
 * client (or per period). This is what lets a firm see "3 of your 40 clients
 * are elevated-risk this month, here's why" — continuous oversight instead of
 * a once-a-year scramble.
 */

import { Finding, SEVERITY_WEIGHT, isOpen } from './findings.js';
import { JournalEntry } from './journal.js';

export type RiskBand = 'bajo' | 'medio' | 'alto';

/** Structured, language-neutral risk factors so the UI can render in any language. */
export interface RiskFactors {
  openFindings: number;
  highFindings: number;
  manualShare: number; // 0..1
  weekendCount: number;
}

export interface RiskScore {
  score: number; // 0..100
  band: RiskBand;
  /** Spanish driver phrases (kept for CLI/back-compat). */
  drivers: string[];
  /** Language-neutral factors for the UI to phrase itself. */
  factors: RiskFactors;
}

function band(score: number): RiskBand {
  if (score >= 60) return 'alto';
  if (score >= 25) return 'medio';
  return 'bajo';
}

/**
 * Score is a bounded, explainable blend of:
 *  - open findings weighted by severity,
 *  - share of manual/adjustment entries,
 *  - weekend-posting share.
 */
export function scoreRisk(input: {
  findings: readonly Finding[];
  entries: readonly JournalEntry[];
}): RiskScore {
  const open = input.findings.filter(isOpen);
  const drivers: string[] = [];

  // Severity DOMINATES. A genuine high-severity finding (duplicate,
  // under-threshold/structuring) must outweigh ratio noise from a client with
  // very few entries — otherwise a tiny clean-ish client with a couple of
  // routine round-number flags could outrank a fraud-pattern client.
  const sevPoints = Math.min(
    75,
    open.reduce((s, f) => s + SEVERITY_WEIGHT[f.severity] * 5, 0),
  );
  if (sevPoints > 0) {
    const highs = open.filter((f) => f.severity === 'high').length;
    drivers.push(
      `${open.length} hallazgo(s) abiertos${highs ? ` (${highs} de severidad alta)` : ''}`,
    );
  }

  const total = input.entries.length || 1;
  const manual = input.entries.filter((e) => /ajuste|manual/i.test(`${e.memo} ${e.source}`)).length;
  const manualShare = manual / total;
  const manualPoints = Math.min(15, Math.round(manualShare * 60));
  if (manualPoints > 0) drivers.push(`${Math.round(manualShare * 100)}% de asientos manuales/ajustes`);

  const weekend = input.entries.filter((e) => {
    const d = new Date(`${e.date}T12:00:00Z`).getUTCDay();
    return d === 0 || d === 6;
  }).length;
  const weekendShare = weekend / total;
  const weekendPoints = Math.min(10, Math.round(weekendShare * 40));
  if (weekendPoints > 0) drivers.push(`${weekend} asiento(s) en fin de semana`);

  const score = Math.min(100, sevPoints + manualPoints + weekendPoints);
  return {
    score,
    band: band(score),
    drivers: drivers.length ? drivers : ['Sin señales de riesgo relevantes'],
    factors: {
      openFindings: open.length,
      highFindings: open.filter((f) => f.severity === 'high').length,
      manualShare,
      weekendCount: weekend,
    },
  };
}
