/**
 * EInvoicingProvider — the seam that keeps DIAN out of the core.
 *
 * In production you integrate a certified Proveedor Tecnológico (PT). You do
 * NOT build DIAN certification yourself for the MVP — that is a multi-month
 * regulatory project and it is not your product. Implement this interface with
 * an adapter that calls your PT's API; the rest of the system never changes.
 */

import { EInvoiceRequest, EInvoiceResult } from './types.js';

export interface EInvoicingProvider {
  readonly key: string;
  /** Send the document for DIAN validation and return the CUFE + status. */
  issue(req: EInvoiceRequest): Promise<EInvoiceResult>;
}
