/**
 * Continuous control rules. Each rule is a PURE function of an entry (plus
 * context) returning zero or more findings-in-waiting. Determinism and
 * explainability are requirements: an auditor must be able to see exactly why
 * something was flagged. No black boxes.
 */

import { JournalEntry, entryAmount } from '../journal.js';
import { Money, abs, formatCOP } from '../money.js';
import { Severity } from '../findings.js';
import { Jurisdiction } from '../jurisdiction.js';
import { COLOMBIA } from '../jurisdictions/colombia.js';

export interface RuleHit {
  rule: string;
  severity: Severity;
  entryId: string;
  message: string;
}

export interface RuleContext {
  /** All previously posted (non-reversed) entries, for cross-entry rules. */
  priorEntries: readonly JournalEntry[];
  /** Approval threshold used by threshold/round rules (centavos). */
  approvalThreshold: Money;
  /** Invoice numbers already issued, for sequence-gap detection. */
  issuedInvoiceNumbers?: readonly string[];
  /** Related-party names/NITs to watch (conflict-of-interest / transfer pricing). */
  relatedParties?: readonly string[];
  /** Active jurisdiction — resolves which accounts count as cash/bank, etc. */
  jurisdiction: Jurisdiction;
}

type Rule = (e: JournalEntry, ctx: RuleContext) => RuleHit[];

const dayOfWeek = (iso: string): number =>
  new Date(`${iso}T12:00:00Z`).getUTCDay(); // 0 Sun .. 6 Sat

/** 1. Postings dated on a weekend — unusual, verify supporting document. */
const weekendPosting: Rule = (e) => {
  const d = dayOfWeek(e.date);
  if (d === 0 || d === 6) {
    return [{
      rule: 'Registro en fin de semana',
      severity: 'medium',
      entryId: e.id,
      message: `Asiento fechado ${e.date} (${d === 0 ? 'domingo' : 'sábado'}). Revisar soporte.`,
    }];
  }
  return [];
};

/** 2. Large, perfectly round amounts — often manual estimates or adjustments. */
const roundAmount: Rule = (e) => {
  const amt = entryAmount(e);
  // >= 1,000,000 pesos (100,000,000 centavos) and a multiple of 100,000 pesos
  if (amt >= 100_000_000n && amt % 10_000_000n === 0n) {
    return [{
      rule: 'Monto redondo inusual',
      severity: 'medium',
      entryId: e.id,
      message: `Valor exacto ${formatCOP(amt)} sin decimales. Posible estimación o ajuste manual.`,
    }];
  }
  return [];
};

/** 3. Amount just under an approval threshold — possible fraccionamiento. */
const underThreshold: Rule = (e, ctx) => {
  const amt = entryAmount(e);
  const floor = (ctx.approvalThreshold * 90n) / 100n; // within 10% below
  if (amt >= floor && amt < ctx.approvalThreshold) {
    return [{
      rule: 'Monto bajo umbral de control',
      severity: 'high',
      entryId: e.id,
      message: `Valor ${formatCOP(amt)} justo por debajo del umbral de aprobación ${formatCOP(ctx.approvalThreshold)}. Posible fraccionamiento.`,
    }];
  }
  return [];
};

/** 4. Duplicate: same source, same date, same amount as a prior entry. */
const duplicate: Rule = (e, ctx) => {
  const amt = entryAmount(e);
  const dup = ctx.priorEntries.find(
    (x) => x.id !== e.id && x.source === e.source && x.date === e.date && entryAmount(x) === amt,
  );
  if (dup) {
    return [{
      rule: 'Posible duplicado',
      severity: 'high',
      entryId: e.id,
      message: `Mismo valor ${formatCOP(amt)}, misma fecha y contraparte que ${dup.id}. Verificar doble registro.`,
    }];
  }
  return [];
};

/**
 * 5. Benford first-digit deviation on a single large expense. A soft signal:
 *    entries whose leading digit is 9 among round-ish large values get a low
 *    flag. (Real Benford analysis runs over a population; here we keep it
 *    explainable and per-entry, escalate in period analysis.)
 */
const benfordLeadingDigit: Rule = (e) => {
  const amt = entryAmount(e);
  if (amt < 50_000_000n) return []; // only meaningful for larger values
  const firstDigit = Number(abs(amt).toString()[0]);
  if (firstDigit === 9) {
    return [{
      rule: 'Dígito inicial atípico (Benford)',
      severity: 'low',
      entryId: e.id,
      message: `El valor ${formatCOP(amt)} inicia en 9; frecuencia baja según la ley de Benford. Señal débil, correlacionar en el periodo.`,
    }];
  }
  return [];
};

/** 6. Manual adjustment to a cash/bank account — higher scrutiny. */
const manualCashAdjustment: Rule = (e, ctx) => {
  const { CASH, BANK } = ctx.jurisdiction.accounts;
  const touchesCash = e.lines.some((l) => l.accountCode === CASH || l.accountCode === BANK);
  const looksManual = /ajuste|manual/i.test(`${e.memo} ${e.source}`);
  if (touchesCash && looksManual) {
    return [{
      rule: 'Ajuste manual a caja/bancos',
      severity: 'medium',
      entryId: e.id,
      message: `Movimiento manual sobre caja/bancos: "${e.memo}". Requiere soporte y aprobación.`,
    }];
  }
  return [];
};

/** 7. Related-party transaction — counterparty on the watchlist. */
const relatedParty: Rule = (e, ctx) => {
  const watch = ctx.relatedParties ?? [];
  const hit = watch.find((w) => e.source.toLowerCase().includes(w.toLowerCase()));
  if (hit) {
    return [{
      rule: 'Transacción con parte relacionada',
      severity: 'medium',
      entryId: e.id,
      message: `Contraparte "${e.source}" figura en la lista de partes relacionadas. Verificar valor de mercado y revelación (NIIF / precios de transferencia).`,
    }];
  }
  return [];
};

export const PER_ENTRY_RULES: Rule[] = [
  weekendPosting,
  roundAmount,
  underThreshold,
  duplicate,
  benfordLeadingDigit,
  manualCashAdjustment,
  relatedParty,
];

/** Cross-entry: detect gaps in the invoice consecutive numbering (regulator-mandated in every jurisdiction so far). */
export function invoiceSequenceGaps(
  numbers: readonly string[],
  jurisdiction: Jurisdiction = COLOMBIA,
): RuleHit[] {
  const parsed = numbers
    .map((n) => ({ n, seq: parseInt(n.split('-')[1] ?? '', 10) }))
    .filter((x) => Number.isFinite(x.seq))
    .sort((a, b) => a.seq - b.seq);
  const hits: RuleHit[] = [];
  for (let i = 1; i < parsed.length; i++) {
    const gap = parsed[i]!.seq - parsed[i - 1]!.seq;
    if (gap > 1) {
      for (let missing = parsed[i - 1]!.seq + 1; missing < parsed[i]!.seq; missing++) {
        const code = `${jurisdiction.invoiceNumberPrefix}-${String(missing).padStart(4, '0')}`;
        hits.push({
          rule: 'Salto en consecutivo',
          severity: 'medium',
          entryId: '—',
          message: jurisdiction.sequenceGapMessage(code),
        });
      }
    }
  }
  return hits;
}

export function runPerEntryRules(e: JournalEntry, ctx: RuleContext): RuleHit[] {
  return PER_ENTRY_RULES.flatMap((rule) => rule(e, ctx));
}
