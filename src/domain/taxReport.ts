/**
 * DIAN tax position for a period — the IVA and retención summary an accountant
 * needs to prepare the declaración. Computed from the ledger, not re-keyed.
 */

import { JournalEntry } from './journal.js';
import { Money, ZERO } from './money.js';
import { naturalBalance } from './reports.js';
import { Jurisdiction } from './jurisdiction.js';
import { COLOMBIA } from './jurisdictions/colombia.js';

export interface TaxPosition {
  ivaGenerado: Money;    // OUTPUT_VAT — VAT/IVA charged on sales (payable)
  ivaDescontable: Money; // INPUT_VAT — VAT/IVA paid on purchases (creditable)
  ivaAPagar: Money;      // neto: generado - descontable (>=0 to pay, <0 saldo a favor)
  saldoAFavor: Money;    // positive when descontable exceeds generado
  retencionPracticada: Money; // WITHHOLDING — retención en la fuente / withholding
}

export function taxPosition(
  entries: readonly JournalEntry[],
  jurisdiction: Jurisdiction = COLOMBIA,
): TaxPosition {
  const acct = jurisdiction.accounts;
  const ivaGenerado = naturalBalance(acct.OUTPUT_VAT, entries, jurisdiction);
  const ivaDescontable = naturalBalance(acct.INPUT_VAT, entries, jurisdiction);
  const neto = ivaGenerado - ivaDescontable;
  return {
    ivaGenerado,
    ivaDescontable,
    ivaAPagar: neto > ZERO ? neto : ZERO,
    saldoAFavor: neto < ZERO ? -neto : ZERO,
    retencionPracticada: naturalBalance(acct.WITHHOLDING, entries, jurisdiction),
  };
}
