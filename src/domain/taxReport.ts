/**
 * DIAN tax position for a period — the IVA and retención summary an accountant
 * needs to prepare the declaración. Computed from the ledger, not re-keyed.
 */

import { JournalEntry } from './journal.js';
import { Money, ZERO } from './money.js';
import { naturalBalance } from './reports.js';
import { ACCT } from './accounts.js';

export interface TaxPosition {
  ivaGenerado: Money;       // 240805 — IVA charged on sales (por pagar)
  ivaDescontable: Money;    // 135515 — IVA paid on purchases (a favor)
  ivaAPagar: Money;         // neto: generado - descontable (>=0 to pay)
  saldoAFavor: Money;       // positive when descontable exceeds generado
  /** Retentions the buyer practiced ON US — an asset / credit against taxes (135595). */
  retencionesAFavor: Money;
  /** Retentions WE practiced on suppliers — a liability owed to DIAN (236540/236715/236805). */
  retencionesPorPagar: Money;
}

export function taxPosition(entries: readonly JournalEntry[]): TaxPosition {
  const ivaGenerado = naturalBalance(ACCT.OUTPUT_VAT, entries);   // output VAT (on sales)
  const ivaDescontable = naturalBalance(ACCT.INPUT_VAT, entries); // input VAT (on purchases)
  const neto = ivaGenerado - ivaDescontable;
  return {
    ivaGenerado,
    ivaDescontable,
    ivaAPagar: neto > ZERO ? neto : ZERO,
    saldoAFavor: neto < ZERO ? -neto : ZERO,
    retencionesAFavor: naturalBalance(ACCT.WHT_RECEIVABLE, entries),
    retencionesPorPagar: naturalBalance(ACCT.WHT_PAYABLE, entries),
  };
}
