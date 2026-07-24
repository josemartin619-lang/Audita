/**
 * InvoiceService — issues a sale as a ZATCA electronic invoice AND posts its
 * double-entry journal entry, atomically from the caller's perspective. The
 * e-invoicing provider is injected, so the same code works with the sandbox
 * or a certified provider.
 *
 * Booking (KSA sale with 15% VAT):
 *   Dr AR                total
 *   Cr Revenue           base
 *   Cr Output VAT        vat
 * (Optional withholding — e.g. government buyers — nets down the receivable to
 *  an asset, WHT receivable.)
 */

import { Money, applyRateBps } from '../domain/money.js';
import { LedgerService } from './ledgerService.js';
import { EInvoicingProvider } from '../einvoicing/provider.js';
import { EInvoiceRequest } from '../einvoicing/types.js';
import { Repository } from '../persistence/repository.js';
import { invoiceSequenceGaps } from '../domain/controls/rules.js';
import { ACCT } from '../domain/accounts.js';

const IVA_BPS = 1500;   // KSA standard VAT 15%

export interface IssueInvoiceInput {
  client: string;
  acquirerId: string;
  date: string;
  concept: string;
  base: Money;           // valor gravable, centavos
  ofeNit: string;
  ambiente?: 1 | 2;
  issueTime?: string;
  reteIcaBps?: number;   // ReteICA on the base (e.g. 69 bps = 0.69%). Default 0.
  reteIvaBps?: number;   // ReteIVA on the IVA amount (e.g. 1500 bps = 15%). Default 0.
  vatBps?: number;       // VAT rate in bps for the client's country. Default 1500 (KSA 15%).
}

export interface IssuedInvoice {
  number: string;
  cufe: string;
  status: string;
  base: Money;
  iva: Money;
  rete: Money;
  reteIca: Money;
  reteIva: Money;
  total: Money;
  entryId: string;
}

export class InvoiceService {
  private invSeq = 0;

  constructor(
    private readonly repo: Repository,
    private readonly ledger: LedgerService,
    private readonly provider: EInvoicingProvider,
  ) {}

  private nextNumber(): string {
    this.invSeq += 1;
    return `FE-${String(this.invSeq).padStart(4, '0')}`;
  }

  /** Force the next consecutive (used to simulate a gap in the demo/tests). */
  skipNumbers(n: number): void {
    this.invSeq += n;
  }

  async issue(input: IssueInvoiceInput): Promise<IssuedInvoice> {
    const iva = applyRateBps(input.base, input.vatBps ?? IVA_BPS);
    const rete = 0n; // KSA has no buyer withholding on standard B2B sales
    const reteIca = input.reteIcaBps ? applyRateBps(input.base, input.reteIcaBps) : 0n;
    const reteIva = input.reteIvaBps ? applyRateBps(iva, input.reteIvaBps) : 0n;
    const wht = rete + reteIca + reteIva;
    const total = input.base + iva - wht;
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

    const { entry } = await this.ledger.post({
      date: input.date,
      memo: `Invoice ${number} — ${input.client}`,
      source: input.client,
      user: 'invoice-service',
      sourceDocument: number,
      // Any withholding the buyer practices ON US is an asset (WHT receivable),
      // netting down the receivable.
      lines: [
        { accountCode: ACCT.AR, debit: total },
        ...(wht > 0n ? [{ accountCode: ACCT.WHT_RECEIVABLE, debit: wht }] : []),
        { accountCode: ACCT.REVENUE, credit: input.base },
        { accountCode: ACCT.OUTPUT_VAT, credit: iva },
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
    return { number, cufe: result.cufe, status: result.status, base: input.base, iva, rete, reteIca, reteIva, total, entryId: entry.id };
  }

  /** Raise findings for any gap in the issued consecutive numbering. */
  private async checkSequence(): Promise<void> {
    const invoices = await this.repo.listInvoices();
    const existing = await this.repo.listFindings();
    const hits = invoiceSequenceGaps(invoices.map((i) => i.number));
    for (const hit of hits) {
      const already = existing.some((f) => f.rule === hit.rule && f.message === hit.message);
      if (!already) await this.ledger.raiseFinding(hit);
    }
  }
}
