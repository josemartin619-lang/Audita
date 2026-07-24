# Saudi Jurisdiction — Reference Pack (verified working code, to port into the canonical repo)

**Status:** this is REFERENCE material extracted from a cloud-sandbox build of Audita that reached a working, tested Saudi state (72 green tests, live ZATCA-format invoices, Arabic chart). The canonical repo is on Jose's machine (Colombia jurisdiction-one + the new `Jurisdiction` seam). **Do not paste these files verbatim** — port them into the seam as `jurisdictions/saudi.ts` + a provider, cleaning the Colombian naming residue noted at the end.

**Why this exists:** Saudi is the actual target and isn't built yet. Building it from nothing risks a rushed add-on. This is a verified starting point: the two hardest pieces (the IFRS/Arabic chart and a correct-shape ZATCA provider with the mandated PIH chain + TLV QR) already done and tested. Treat the *structure* as solid; treat the *live integration* (CSID stamp, Fatoora clearance call) as still gated on ZATCA onboarding.

---

## 1. How these map onto the `Jurisdiction` config seam

Sonnet's seam (per the executor report) pulls chart / tax / currency / provider / compliance-strings into one `Jurisdiction` object, with Colombia as jurisdiction one. Saudi becomes a second **real** jurisdiction (not the throwaway fixture). The pieces below fill these fields:

- `chart` + `accounts` (semantic key → code) ← Section 2
- `tax` (VAT standard rate + accounts, withholding **disabled**) ← Section 3
- `currency` (SAR, 2 minor digits) ← Section 3
- `eInvoicing.makeProvider` ← Section 4 (the ZATCA provider)
- `eInvoicing.numberingGapMessage` ← Section 3
- `defaultLocale: 'ar'`

---

## 2. KSA chart of accounts — IFRS-based, English + Arabic

Semantic keys stay identical to the existing `ACCT` enum so no domain function changes; only the code mapping + names + Arabic differ per jurisdiction.

```
Semantic key        Code    English                              Arabic
CASH                1000    Cash on hand                         النقد في الصندوق
BANK                1010    Bank                                 البنك
AR                  1100    Accounts receivable                  الذمم المدينة
INPUT_VAT           1150    Input VAT (recoverable)              ضريبة القيمة المضافة على المدخلات
WHT_RECEIVABLE      1160    Withholding tax receivable           ضريبة الاستقطاع المستحقة لنا
INVENTORY           1200    Inventory                            المخزون
PPE                 1500    Property, plant & equipment          الممتلكات والمعدات
AP                  2000    Accounts payable                     الذمم الدائنة
OUTPUT_VAT          2100    Output VAT (payable)                 ضريبة القيمة المضافة على المخرجات
WHT_PAYABLE         2110    Withholding tax payable              ضريبة الاستقطاع المستحقة
CAPITAL             3000    Share capital                        رأس المال
REVENUE             4000    Revenue                              الإيرادات
COGS                5000    Cost of goods sold                   تكلفة البضاعة المباعة
ADMIN_EXP           6000    General & administrative expenses    مصاريف عمومية وإدارية
SELLING_EXP         6100    Selling & distribution expenses      مصاريف بيع وتوزيع
```
Account types: assets (D-normal): CASH, BANK, AR, INPUT_VAT, WHT_RECEIVABLE, INVENTORY, PPE. Liabilities (C-normal): AP, OUTPUT_VAT, WHT_PAYABLE. Equity (C): CAPITAL. Revenue (C): REVENUE. COGS (D). Expenses (D): ADMIN_EXP, SELLING_EXP. `CASH_AND_BANK = [CASH, BANK]` for reconciliation & cash-flow.

---

## 3. KSA tax + currency + compliance profile

- **VAT:** standard rate **15% (1500 bps)** — the single source of truth for the rate. Output VAT → `2100`, Input VAT → `1150`.
- **Withholding:** **disabled** for standard B2B sales (KSA has no buyer withholding equivalent to Colombian retención). The withholding accounts exist in the chart for completeness but the jurisdiction's `tax.withholding = { enabled: false }`. (This is the axis the fixture jurisdiction should turn ON, so the seam is proven on a jurisdiction that differs from KSA.)
- **Currency:** `SAR`, 2 minor digits (halalas), `en-US`-style grouping, symbol prefix: `SAR 1,234.50`.
- **Numbering-gap control message (ZATCA-specific):**
  `Invoice ${code} is missing from the issued sequence. ZATCA requires continuous numbering (ICV / PIH chain).`
- **Default locale:** `ar` (Arabic-first, matching the market).

---

## 4. ZATCA e-invoicing provider (verified working, portable)

Implements the shared `EInvoicingProvider` interface. Computes the **real** PIH chain (SHA-256, genesis = 64 zeros) + **real** TLV QR (tags 1–6). Only the live CSID cryptographic stamp and the Fatoora clearance call are mocked — those drop in behind the same interface once ZATCA onboarding + credentials exist. Uses only `node:crypto`.

```ts
import { createHash, randomUUID } from 'node:crypto';
import { EInvoicingProvider } from './provider.js';
import { EInvoiceRequest, EInvoiceResult } from './types.js';
import { Money, toMajorNumber } from '../domain/money.js';   // was toPesosNumber — see §5

const money2 = (m: Money): string => toMajorNumber(m).toFixed(2);
const GENESIS_PIH = '0'.repeat(64);

/** TLV encode: [tag][len][value] triplets, base64. */
function tlv(fields: { tag: number; value: string }[]): string {
  const parts: Buffer[] = [];
  for (const f of fields) {
    const v = Buffer.from(f.value, 'utf8');
    parts.push(Buffer.from([f.tag, v.length]), v);
  }
  return Buffer.concat(parts).toString('base64');
}

export interface ZatcaConfig { sellerName?: string; vatNumber?: string; }

export class ZatcaEInvoicingProvider implements EInvoicingProvider {
  readonly key = 'zatca';
  private icv = 0;                 // Invoice Counter Value — never resets
  private pih = GENESIS_PIH;       // Previous Invoice Hash
  constructor(private readonly cfg: ZatcaConfig = {}) {}

  async issue(req: EInvoiceRequest): Promise<EInvoiceResult> {
    this.icv += 1;
    const canonical = [
      req.number, req.issueDate, req.issueTime, req.sellerVatNo, req.buyerId,
      money2(req.base), money2(req.vat), money2(req.total), String(this.icv), this.pih,
    ].join('|');
    const invoiceHash = createHash('sha256').update(canonical, 'utf8').digest('hex');
    const uuid = randomUUID();
    const qr = tlv([
      { tag: 1, value: this.cfg.sellerName ?? req.sellerVatNo },
      { tag: 2, value: this.cfg.vatNumber ?? req.sellerVatNo },
      { tag: 3, value: `${req.issueDate}T${req.issueTime}` },
      { tag: 4, value: money2(req.total) },
      { tag: 5, value: money2(req.vat) },
      { tag: 6, value: invoiceHash },
    ]);
    const result: EInvoiceResult = {
      number: req.number,
      invoiceHash,               // unique clearing code
      status: 'CLEARED',
      qrData: qr,
      raw: { provider: 'zatca', uuid, icv: this.icv, pih: this.pih,
             note: 'Real PIH chain + TLV QR; live CSID stamp requires ZATCA onboarding.' },
    };
    this.pih = invoiceHash;      // advance the chain
    return result;
  }
}
```

**Field spec for the QR (ZATCA Phase 2, tags 1–6):** 1 = seller name, 2 = seller VAT registration number (15 digits), 3 = invoice timestamp (ISO8601), 4 = invoice total incl. VAT, 5 = VAT amount, 6 = invoice hash. TLV, then base64. This is what a ZATCA-compliant QR decodes to — so a phone QR scanner will read real fields, which is a strong "this is real" demo moment (see below).

---

## 5. Naming residue to clean while porting (Colombian lineage leftovers)

The sandbox carried Colombian field names. Rename on the way in:
- `ofeNit` / `acquirerId` → `sellerVatNo` / `buyerId` (invoice request fields)
- `cufe` → `invoiceHash` (result field) — CUFE is the Colombian term; ZATCA has no CUFE
- `status: 'VALIDADA'` → `'CLEARED'` (ZATCA terminology)
- `toPesosNumber` → `toMajorNumber`, `formatCOP` → `formatMoney`/`formatSAR` (align with the money-naming cleanup in the foundation plan)

None of these change behavior — they're string/identifier renames. The PIH chain, ICV counter, and TLV encoding are correct as-is.

---

## 6. What's real vs still gated
- **Real (works today):** the PIH hash chain, the non-resetting ICV counter, the TLV QR encoding with correct Phase-2 fields, the IFRS/Arabic chart, 15% VAT.
- **Gated (needs ZATCA onboarding + credentials, do NOT fake):** the live CSID cryptographic stamp and the Fatoora clearance/reporting API call. Keep them behind `EInvoicingProvider`; the simulated provider above is the correct scaffold to swap out later.
