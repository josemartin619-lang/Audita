/**
 * HttpPTProvider — adapter for a certified Proveedor Tecnológico exposed over a
 * REST API (the common integration model in Colombia; e.g. providers offering a
 * "/invoices" endpoint that returns the CUFE and the DIAN validation result).
 *
 * This is the REAL integration shape. It makes an authenticated HTTPS call and
 * maps the provider's response onto our EInvoiceResult. It stays inert only
 * because you must supply YOUR provider's base URL + token (from .env). Once you
 * open an account with a PT and drop in those credentials, invoicing goes live
 * with no change to the rest of the system.
 *
 * Endpoint/field names below follow the typical PT contract; adjust the two
 * marked spots to match your provider's published API.
 */

import { EInvoicingProvider } from './provider.js';
import { EInvoiceRequest, EInvoiceResult } from './types.js';
import { toPesosNumber } from '../domain/money.js';
import { SandboxEInvoicingProvider } from './sandboxProvider.js';

export interface HttpProviderConfig {
  key: string;                 // provider identifier, e.g. "matias" | "facturatech"
  baseUrl: string;             // e.g. https://api.<provider>.com
  token: string;               // bearer token / API key
  softwareId: string;          // DIAN SoftwareID
  softwarePin: string;         // DIAN SoftwarePIN
  claveTecnica: string;        // ClaveTecnica from resolución de habilitación
  ambiente: 1 | 2;             // 1 producción, 2 pruebas
  fetchImpl?: typeof fetch;    // injectable for testing
  timeoutMs?: number;
}

export class HttpPTProvider implements EInvoicingProvider {
  readonly key: string;
  private readonly cfg: HttpProviderConfig;
  private readonly doFetch: typeof fetch;

  constructor(cfg: HttpProviderConfig) {
    if (!cfg.baseUrl || !cfg.token) {
      throw new Error(
        'HttpPTProvider requiere baseUrl y token del proveedor tecnológico. ' +
          'Configúralos en .env (EINVOICE_API_BASE, EINVOICE_API_TOKEN).',
      );
    }
    this.cfg = cfg;
    this.key = cfg.key;
    this.doFetch = cfg.fetchImpl ?? fetch;
  }

  async issue(req: EInvoiceRequest): Promise<EInvoiceResult> {
    // ---- (1) Map our request to the provider's expected payload ----
    const payload = {
      number: req.number,
      issue_date: req.issueDate,
      issue_time: req.issueTime,
      ambiente: this.cfg.ambiente,
      software_id: this.cfg.softwareId,
      software_pin: this.cfg.softwarePin,
      clave_tecnica: this.cfg.claveTecnica,
      seller: { nit: req.ofeNit },
      buyer: { id: req.acquirerId, name: req.acquirerName },
      totals: {
        base: toPesosNumber(req.base),
        iva: toPesosNumber(req.iva),
        withholding: toPesosNumber(req.reteFuente),
        total: toPesosNumber(req.total),
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await this.doFetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/invoices`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.token}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Proveedor DIAN respondió ${res.status}: ${text.slice(0, 300)}`);
    }

    // ---- (2) Map the provider's response onto EInvoiceResult ----
    const body = (await res.json()) as {
      cufe?: string;
      status?: string;
      qr?: string;
      qr_data?: string;
    };
    if (!body.cufe) {
      throw new Error('Respuesta del proveedor sin CUFE; factura no validada por DIAN.');
    }
    const status =
      (body.status ?? '').toUpperCase() === 'ACCEPTED' || (body.status ?? '').toUpperCase() === 'VALIDADA'
        ? 'VALIDADA'
        : (body.status ?? '').toUpperCase() === 'REJECTED'
          ? 'RECHAZADA'
          : 'PENDIENTE';

    return {
      number: req.number,
      cufe: body.cufe,
      status,
      qrData: body.qr ?? body.qr_data ?? '',
      raw: body,
    };
  }
}

/** Factory: choose provider from env. Falls back to sandbox when unconfigured. */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): {
  key: string;
  make: () => EInvoicingProvider;
} {
  const key = env.EINVOICE_PROVIDER ?? 'sandbox';
  if (key === 'sandbox' || !env.EINVOICE_API_BASE) {
    return {
      key: 'sandbox',
      make: () => new SandboxEInvoicingProvider({ claveTecnica: env.EINVOICE_CLAVE_TECNICA }),
    };
  }
  return {
    key,
    make: () =>
      new HttpPTProvider({
        key,
        baseUrl: env.EINVOICE_API_BASE!,
        token: env.EINVOICE_API_TOKEN ?? '',
        softwareId: env.EINVOICE_SOFTWARE_ID ?? '',
        softwarePin: env.EINVOICE_SOFTWARE_PIN ?? '',
        claveTecnica: env.EINVOICE_CLAVE_TECNICA ?? '',
        ambiente: (Number(env.DIAN_AMBIENTE) === 1 ? 1 : 2),
      }),
  };
}
