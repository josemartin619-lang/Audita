/**
 * FirmWorkspace — the multi-client console. An accounting FIRM is the customer;
 * each of its clients has its OWN isolated ledger. Isolation is structural: a
 * separate Repository per client, so there is no query path that can leak one
 * client's books into another. (In production, inject a tenant-scoped Postgres
 * repository via `repoFactory` instead of the in-memory one.)
 *
 * This is what makes it a firm product rather than an SMB tool: one login,
 * many books, and a console that surfaces which clients are elevated-risk.
 */

import { Money } from '../domain/money.js';
import { Repository } from '../persistence/repository.js';
import { MemoryRepository } from '../persistence/memoryRepo.js';
import { EInvoicingProvider } from '../einvoicing/provider.js';
import { ZatcaEInvoicingProvider } from '../einvoicing/zatcaProvider.js';
import { LedgerService } from './ledgerService.js';
import { InvoiceService } from './invoiceService.js';
import { scoreRisk, RiskScore } from '../domain/riskScoring.js';
import { isOpen } from '../domain/findings.js';

export interface ClientMeta {
  clientId: string;
  name: string;
  ofeNit: string;
  country?: string; // GCC country id (ISO-2): 'SA','AE','BH','OM','QA','KW'. Default 'SA'.
}

export interface ClientLedger {
  meta: ClientMeta;
  repo: Repository;
  ledger: LedgerService;
  invoices: InvoiceService;
}

export interface FirmOptions {
  user: string;
  approvalThreshold: Money;
  relatedParties?: readonly string[];
  /** Provide a tenant-scoped repository per client (defaults to in-memory). */
  repoFactory?: (clientId: string) => Repository;
  /** Provide the e-invoicing provider per client (defaults to sandbox). */
  providerFactory?: (meta: ClientMeta) => EInvoicingProvider;
  clock?: () => string;
}

export interface ConsoleRow {
  clientId: string;
  name: string;
  country: string;
  risk: RiskScore;
  openFindings: number;
  entryCount: number;
}

export class FirmWorkspace {
  private readonly clients = new Map<string, ClientLedger>();

  constructor(private readonly opts: FirmOptions) {}

  addClient(meta: ClientMeta): ClientLedger {
    if (this.clients.has(meta.clientId)) {
      throw new Error(`El cliente ${meta.clientId} ya existe en el espacio de la firma.`);
    }
    const repo = this.opts.repoFactory?.(meta.clientId) ?? new MemoryRepository();
    const ledger = new LedgerService(repo, {
      user: this.opts.user,
      approvalThreshold: this.opts.approvalThreshold,
      relatedParties: this.opts.relatedParties,
      clock: this.opts.clock,
    });
    const provider = this.opts.providerFactory?.(meta) ?? new ZatcaEInvoicingProvider({ sellerName: meta.name, vatNumber: meta.ofeNit });
    const invoices = new InvoiceService(repo, ledger, provider);
    const cl: ClientLedger = { meta, repo, ledger, invoices };
    this.clients.set(meta.clientId, cl);
    return cl;
  }

  client(clientId: string): ClientLedger {
    const c = this.clients.get(clientId);
    if (!c) throw new Error(`Cliente no encontrado: ${clientId}`);
    return c;
  }

  listClients(): ClientMeta[] {
    return [...this.clients.values()].map((c) => ({ ...c.meta }));
  }

  /** The console: every client with its current risk. Sorted highest-risk first. */
  async console(): Promise<ConsoleRow[]> {
    const rows: ConsoleRow[] = [];
    for (const c of this.clients.values()) {
      const [entries, findings] = await Promise.all([c.repo.listEntries(), c.repo.listFindings()]);
      rows.push({
        clientId: c.meta.clientId,
        name: c.meta.name,
        country: c.meta.country ?? 'SA',
        risk: scoreRisk({ findings, entries }),
        openFindings: findings.filter(isOpen).length,
        entryCount: entries.length,
      });
    }
    return rows.sort((a, b) => b.risk.score - a.risk.score);
  }
}
