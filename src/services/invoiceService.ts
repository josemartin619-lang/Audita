/**
 * InvoiceService — issues a sale as a DIAN electronic invoice AND posts its
 * double-entry journal entry, atomically from the caller's perspective. The
 * e-invoicing provider is injected, so the same code works with the sandbox
 * or a certified Proveedor Tecnológico.
 *
 * Booking (Colombian sale with IVA 19% and retefuente withheld by the buyer):
 *   Dr 130505 Clientes            total
 *   Dr 236540 Retención (activo por menor pago)  rete
 *   Cr 413505 Ingresos            base
 *   Cr 240805 IVA por pagar       iva
 */

import { Money, applyRateBps } from '../domain/money.js';
import { LedgerService } from './ledgerService.js';
import { EInvoicingProvider } from '../einvoicing/provider.js';
import { EInvoiceRequest } from '../einvoicing/types.js';
import { Repository } from '../persistence/repository.js';
import { invoiceSequenceGaps } from '../domain/controls/rules.js';
import { Jurisdiction } from '../domain/jurisdiction.js';
import { COLOMBIA } from '../domain/jurisdictions/colombia.js';

export interface IssueInvoiceInput {
  client: string;
  acquirerId: string;
  date: string;
  concept: string;
  base: Money;           // valor gravable, centavos
  ofeNit: string;
  ambiente?: 1 | 2;
  issueTime?: string;
}

export interface IssuedInvoice {
  number: string;
  cufe: string;
  status: string;
  base: Money;
  iva: Money;
  rete: Money;
  total: Money;
  entryId: string;
}

export class InvoiceService {
  private invSeq = 0;
  private readonly jurisdiction: Jurisdiction;

  constructor(
    private readonly repo: Repository,
    private readonly ledger: LedgerService,
    private readonly provider: EInvoicingProvider,
    jurisdiction: Jurisdiction = COLOMBIA,
  ) {
    this.jurisdiction = jurisdiction;
  }

  private nextNumber(): string {
    this.invSeq += 1;
    return `${this.jurisdiction.invoiceNumberPrefix}-${String(this.invSeq).padStart(4, '0')}`;
  }

  /** Force the next consecutive (used to simulate a gap in the demo/tests). */
  skipNumbers(n: number): void {
    this.invSeq += n;
  }

  async issue(input: IssueInvoiceInput): Promise<IssuedInvoice> {
    const { vatStandardBps, withholding } = this.jurisdiction.tax;
    const iva = applyRateBps(input.base, vatStandardBps);
    const rete = withholding.enabled ? applyRateBps(input.base, withholding.defaultBps) : 0n;
    const total = input.base + iva - rete;
    const number = this.nextNumber();

    const req: EInvoiceRequest = {
      number,
      issueDate: input.date,
      issueTime: input.issueTime ?? '10:00:00-05:00',
      ofeNit: input.ofeNit,
      acquirerId: input.acquirerId,
      acquirerName: input.client,
      base: input.base,
      iva,
      reteFuente: rete,
      total,
      ambiente: input.ambiente ?? 2,
    };
    const result = await this.provider.issue(req);

    const acct = this.jurisdiction.accounts;
    // A zero-value line is invalid (normalizeLines requires every line to
    // carry a debit or credit), so the withholding line only exists at all
    // when this jurisdiction actually withholds. Skipping it when disabled
    // isn't a workaround — it's the correct entry for a jurisdiction with no
    // withholding concept, not a Colombian entry with a zeroed-out row.
    const { entry } = await this.ledger.post({
      date: input.date,
      memo: `Factura ${number} — ${input.client}`,
      source: input.client,
      user: 'invoice-service',
      sourceDocument: number,
      lines: [
        { accountCode: acct.ACCOUNTS_RECEIVABLE, debit: total },
        ...(rete > 0n ? [{ accountCode: acct.WITHHOLDING, debit: rete }] : []),
        { accountCode: acct.REVENUE, credit: input.base },
        { accountCode: acct.OUTPUT_VAT, credit: iva },
      ],
    });

    await this.repo.saveInvoice({
      number,
      client: input.client,
      date: input.date,
      cufe: result.cufe,
      status: result.status,
      entryId: entry.id,
    });
    const ev = this.ledger.auditTrail().append({
      action: 'ISSUE_INVOICE',
      ref: number,
      detail: { cufe: result.cufe, client: input.client, total: total.toString(), status: result.status },
      user: 'invoice-service',
      ts: entry.recordedAt,
    });
    await this.repo.appendAudit(ev);

    await this.checkSequence();
    return { number, cufe: result.cufe, status: result.status, base: input.base, iva, rete, total, entryId: entry.id };
  }

  /** Raise findings for any gap in the issued consecutive numbering. */
  private async checkSequence(): Promise<void> {
    const invoices = await this.repo.listInvoices();
    const existing = await this.repo.listFindings();
    const hits = invoiceSequenceGaps(invoices.map((i) => i.number), this.jurisdiction);
    for (const hit of hits) {
      const already = existing.some((f) => f.rule === hit.rule && f.message === hit.message);
      if (!already) await this.ledger.raiseFinding(hit);
    }
  }
}
