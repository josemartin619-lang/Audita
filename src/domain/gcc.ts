/**
 * GCC jurisdictions. The six Gulf states run genuinely different tax regimes —
 * VAT rates diverge (0–15%), e-invoicing regimes differ (ZATCA hash-chain vs
 * Peppol network vs none yet), and three of the currencies use THREE decimal
 * places (fils/baisa), not two. A GCC accounting product has to know all of
 * this per client. Figures verified for 2026; see the compliance module.
 */

export interface GccCountry {
  id: string;            // ISO-2
  name: string;
  nameAr: string;
  flag: string;          // emoji
  currency: { code: string; decimals: number };
  vatBps: number;        // 1500 = 15%; 0 = no VAT in force
  corpTaxPct: number;    // headline corporate income tax
  zakatPct: number | null; // religious wealth levy where administered (null = n/a)
  eInvoicing: { regime: string; status: string };
  locale: 'ar' | 'en';
  note: string;
}

export const GCC: readonly GccCountry[] = [
  {
    id: 'SA', name: 'Saudi Arabia', nameAr: 'المملكة العربية السعودية', flag: '🇸🇦',
    currency: { code: 'SAR', decimals: 2 }, vatBps: 1500, corpTaxPct: 20, zakatPct: 2.5,
    eInvoicing: { regime: 'ZATCA — Fatoora', status: 'Live · mandatory' }, locale: 'ar',
    note: 'Highest VAT in the GCC. ZATCA Phase 2 mandates a Previous-Invoice-Hash chain — Audita’s native architecture. Zakat administered by ZATCA.',
  },
  {
    id: 'AE', name: 'United Arab Emirates', nameAr: 'الإمارات العربية المتحدة', flag: '🇦🇪',
    currency: { code: 'AED', decimals: 2 }, vatBps: 500, corpTaxPct: 9, zakatPct: null,
    eInvoicing: { regime: 'Peppol (PINT AE)', status: 'Mandatory · Jul 2026' }, locale: 'en',
    note: '9% corporate tax since 2023 (above AED 375k). E-invoicing is a Peppol 5-corner network with accredited service providers — a different model to ZATCA.',
  },
  {
    id: 'BH', name: 'Bahrain', nameAr: 'البحرين', flag: '🇧🇭',
    currency: { code: 'BHD', decimals: 3 }, vatBps: 1000, corpTaxPct: 0, zakatPct: null,
    eInvoicing: { regime: 'NBR e-invoicing', status: 'Planned · phased' }, locale: 'ar',
    note: '10% VAT (2022). No general corporate tax (46% on hydrocarbons only). BHD is a 3-decimal currency (1000 fils).',
  },
  {
    id: 'OM', name: 'Oman', nameAr: 'عُمان', flag: '🇴🇲',
    currency: { code: 'OMR', decimals: 3 }, vatBps: 500, corpTaxPct: 15, zakatPct: null,
    eInvoicing: { regime: 'OTA e-invoicing', status: 'Planned · 2026' }, locale: 'ar',
    note: '5% VAT (2021), 15% corporate tax, 10% withholding on royalties to non-residents. OMR is a 3-decimal currency (1000 baisa).',
  },
  {
    id: 'QA', name: 'Qatar', nameAr: 'قطر', flag: '🇶🇦',
    currency: { code: 'QAR', decimals: 2 }, vatBps: 0, corpTaxPct: 10, zakatPct: null,
    eInvoicing: { regime: 'Qatar Tax Authority', status: 'Voluntary' }, locale: 'ar',
    note: 'No VAT in force yet (long anticipated). 10% corporate tax; 5% withholding on interest/royalties to non-residents.',
  },
  {
    id: 'KW', name: 'Kuwait', nameAr: 'الكويت', flag: '🇰🇼',
    currency: { code: 'KWD', decimals: 3 }, vatBps: 0, corpTaxPct: 15, zakatPct: 1,
    eInvoicing: { regime: 'Early development', status: 'Not yet' }, locale: 'ar',
    note: 'No VAT (ruled out for now). 15% corporate tax on foreign entities. Zakat/NLST ~1% of net profit. KWD is a 3-decimal currency (1000 fils) — the highest-value currency in the world.',
  },
];

export const gccCountry = (id: string | undefined): GccCountry =>
  GCC.find((c) => c.id === id) ?? GCC[0]!;
