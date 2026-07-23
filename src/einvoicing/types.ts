import { Money } from '../domain/money.js';

/** A sale document to be turned into a DIAN electronic invoice. */
export interface EInvoiceRequest {
  number: string;          // consecutive, e.g. FE-0007
  issueDate: string;       // YYYY-MM-DD
  issueTime: string;       // HH:mm:ss-05:00
  ofeNit: string;          // issuer NIT
  acquirerId: string;      // customer NIT/CC
  acquirerName: string;
  base: Money;             // valor bruto (centavos)
  iva: Money;              // impuesto 01 (centavos)
  reteFuente: Money;       // retención (centavos) — withheld, not a DIAN tax code
  total: Money;            // valor total a pagar (centavos)
  ambiente: 1 | 2;         // 1 producción, 2 pruebas
}

export interface EInvoiceResult {
  number: string;
  cufe: string;            // SHA-384 unique code
  status: 'VALIDADA' | 'RECHAZADA' | 'PENDIENTE';
  qrData: string;
  /** Provider/DIAN raw response, if any. */
  raw?: unknown;
}
