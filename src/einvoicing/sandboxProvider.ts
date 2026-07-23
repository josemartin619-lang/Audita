/**
 * SandboxEInvoicingProvider — a local, no-network adapter that computes the
 * CUFE using DIAN's ACTUAL algorithm (SHA-384 over the ordered field string,
 * per Anexo Técnico de Factura Electrónica). Only the ClaveTecnica and the
 * live DIAN round-trip are mocked; the code shape is real, so swapping in a
 * certified provider is a drop-in replacement.
 *
 * Reference field order (validación previa):
 *   NumFac + FecFac + HorFac + ValFac + CodImp1(01) + ValImp1 +
 *   CodImp2(04) + ValImp2 + CodImp3(03) + ValImp3 + ValTol +
 *   NitOFE + NumAdq + ClTec + TipoAmbiente
 */

import { createHash } from 'node:crypto';
import { EInvoicingProvider } from './provider.js';
import { EInvoiceRequest, EInvoiceResult } from './types.js';
import { Money, toPesosNumber } from '../domain/money.js';

const money2 = (m: Money): string => toPesosNumber(m).toFixed(2);

export interface SandboxConfig {
  /** Stand-in for the DIAN ClaveTecnica from the resolución de habilitación. */
  claveTecnica?: string;
}

export class SandboxEInvoicingProvider implements EInvoicingProvider {
  readonly key = 'sandbox';
  private claveTecnica: string;

  constructor(cfg: SandboxConfig = {}) {
    this.claveTecnica = cfg.claveTecnica ?? 'SANDBOX-CLAVE-TECNICA-0000000000000000';
  }

  async issue(req: EInvoiceRequest): Promise<EInvoiceResult> {
    const fields = [
      req.number,
      req.issueDate,
      req.issueTime,
      money2(req.base),
      '01', money2(req.iva),
      '04', '0.00',
      '03', '0.00',
      money2(req.total),
      req.ofeNit,
      req.acquirerId,
      this.claveTecnica,
      String(req.ambiente),
    ].join('');

    const cufe = createHash('sha384').update(fields, 'utf8').digest('hex');
    const qrData =
      `NumFac=${req.number};FecFac=${req.issueDate};` +
      `NitFac=${req.ofeNit};DocAdq=${req.acquirerId};` +
      `ValFac=${money2(req.base)};ValIva=${money2(req.iva)};` +
      `ValTolFac=${money2(req.total)};CUFE=${cufe}`;

    return {
      number: req.number,
      cufe,
      status: 'VALIDADA',
      qrData,
      raw: { provider: 'sandbox', note: 'No live DIAN call. CUFE computed with real formula.' },
    };
  }
}
