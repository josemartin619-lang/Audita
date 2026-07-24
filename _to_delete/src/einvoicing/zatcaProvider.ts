/**
 * ZatcaEInvoicingProvider — Saudi Arabia (ZATCA / Fatoora) e-invoicing.
 *
 * ZATCA Phase 2 mandates that every invoice carry:
 *   - a UUID,
 *   - an ICV (Invoice Counter Value) — a non-resetting per-device counter,
 *   - a PIH (Previous Invoice Hash) — the hash of the prior invoice, forming a
 *     tamper-evident chain,
 *   - a cryptographic stamp, and
 *   - a QR code in TLV (Tag-Length-Value) form.
 *
 * The PIH chain is EXACTLY the append-only hash chain Audita is built on — so
 * ZATCA compliance falls out of the architecture rather than being bolted on.
 * This sandbox computes the real hash chain and TLV QR; the live cryptographic
 * stamp (CSID) and the DIAN-style clearance call are the only mocked parts, and
 * they drop in behind the same interface with certified credentials.
 */

import { createHash, randomUUID } from 'node:crypto';
import { EInvoicingProvider } from './provider.js';
import { EInvoiceRequest, EInvoiceResult } from './types.js';
import { Money, toPesosNumber } from '../domain/money.js';

const money2 = (m: Money): string => toPesosNumber(m).toFixed(2);
const GENESIS_PIH = '0'.repeat(64);

/** TLV encode: one Buffer of [tag][len][value] triplets, base64 at the end. */
function tlv(fields: { tag: number; value: string }[]): string {
  const parts: Buffer[] = [];
  for (const f of fields) {
    const v = Buffer.from(f.value, 'utf8');
    parts.push(Buffer.from([f.tag, v.length]), v);
  }
  return Buffer.concat(parts).toString('base64');
}

export interface ZatcaConfig {
  sellerName?: string;
  vatNumber?: string;   // 15-digit VAT registration number
}

export class ZatcaEInvoicingProvider implements EInvoicingProvider {
  readonly key = 'zatca';
  private icv = 0;                 // Invoice Counter Value (never resets)
  private pih = GENESIS_PIH;       // Previous Invoice Hash
  private readonly cfg: ZatcaConfig;

  constructor(cfg: ZatcaConfig = {}) {
    this.cfg = cfg;
  }

  async issue(req: EInvoiceRequest): Promise<EInvoiceResult> {
    this.icv += 1;

    // Invoice hash chained to the previous invoice's hash (the mandated PIH).
    const canonical = [
      req.number, req.issueDate, req.issueTime, req.ofeNit, req.acquirerId,
      money2(req.base), money2(req.iva), money2(req.total), String(this.icv), this.pih,
    ].join('|');
    const invoiceHash = createHash('sha256').update(canonical, 'utf8').digest('hex');
    const uuid = randomUUID();

    // ZATCA QR (TLV): seller, VAT no., timestamp, total (incl. VAT), VAT amount, hash.
    const qr = tlv([
      { tag: 1, value: this.cfg.sellerName ?? req.ofeNit },
      { tag: 2, value: this.cfg.vatNumber ?? req.ofeNit },
      { tag: 3, value: `${req.issueDate}T${req.issueTime}` },
      { tag: 4, value: money2(req.total) },
      { tag: 5, value: money2(req.iva) },
      { tag: 6, value: invoiceHash },
    ]);

    const result: EInvoiceResult = {
      number: req.number,
      cufe: invoiceHash,       // the ZATCA invoice hash (unique code)
      status: 'VALIDADA',      // "CLEARED" in ZATCA terms
      qrData: qr,
      raw: { provider: 'zatca', uuid, icv: this.icv, pih: this.pih, note: 'Sandbox: real PIH chain + TLV QR; live CSID stamp requires ZATCA onboarding.' },
    };

    // Advance the chain.
    this.pih = invoiceHash;
    return result;
  }
}
