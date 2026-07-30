/**
 * VAT treatments and per-jurisdiction rules.
 *
 * A single VAT rate is not enough to run books in the Gulf. The same physical
 * supply is standard-rated in one state, zero-rated in the next and exempt in a
 * third — and the difference is not cosmetic: a zero-rated supply keeps input
 * VAT recoverable, an exempt supply destroys that recovery, and an out-of-scope
 * supply never reaches the return at all. This module models the treatment as a
 * first-class attribute of a line, and carries the jurisdiction-specific
 * catalogue of which supplies fall where.
 *
 * IMPORTANT — this catalogue is a working reference for preparers, not tax
 * advice, and not a substitute for the statute. Rates and category lists change;
 * each jurisdiction below carries the authority and the primary source so a
 * qualified adviser can verify before filing. Where a jurisdiction has no VAT in
 * force the catalogue says so rather than guessing.
 */

export type VatTreatmentCode =
  | 'standard'
  | 'zero_rated'
  | 'exempt'
  | 'out_of_scope'
  | 'reverse_charge';

export interface VatTreatment {
  code: VatTreatmentCode;
  name: string;
  nameAr: string;
  /** Rate in basis points, or null to take the jurisdiction's standard rate. */
  rateBps: number | null;
  /** Can input VAT on costs attributable to this supply be recovered? */
  inputRecoverable: boolean;
  /** Does the supply appear on the VAT return? */
  reportable: boolean;
  /** Does the buyer, rather than the seller, account for the output VAT? */
  buyerAccounts: boolean;
  explain: string;
}

export const TREATMENTS: readonly VatTreatment[] = [
  {
    code: 'standard', name: 'Standard-rated', nameAr: 'خاضعة للنسبة الأساسية',
    rateBps: null, inputRecoverable: true, reportable: true, buyerAccounts: false,
    explain: 'VAT charged at the jurisdiction\'s standard rate. Input VAT on related costs is recoverable.',
  },
  {
    code: 'zero_rated', name: 'Zero-rated', nameAr: 'خاضعة بنسبة صفر',
    rateBps: 0, inputRecoverable: true, reportable: true, buyerAccounts: false,
    explain: 'A taxable supply at 0%. It still goes on the return, and input VAT on related costs stays recoverable — this is the key difference from exempt.',
  },
  {
    code: 'exempt', name: 'Exempt', nameAr: 'معفاة',
    rateBps: 0, inputRecoverable: false, reportable: true, buyerAccounts: false,
    explain: 'No VAT charged and input VAT on related costs is NOT recoverable. Mixed activity forces an apportionment calculation.',
  },
  {
    code: 'out_of_scope', name: 'Out of scope', nameAr: 'خارج نطاق الضريبة',
    rateBps: 0, inputRecoverable: false, reportable: false, buyerAccounts: false,
    explain: 'Outside the VAT system entirely — it does not belong on the return. Often another tax applies instead (e.g. real-estate transaction tax).',
  },
  {
    code: 'reverse_charge', name: 'Reverse charge', nameAr: 'الاحتساب العكسي',
    rateBps: null, inputRecoverable: true, reportable: true, buyerAccounts: true,
    explain: 'The buyer self-accounts for the output VAT AND claims the matching input VAT — typically imported services. Both sides go on the return; cash effect is usually nil for a fully taxable buyer.',
  },
] as const;

const BY_CODE = new Map(TREATMENTS.map((t) => [t.code, t]));

export function treatment(code: string): VatTreatment {
  const t = BY_CODE.get(code as VatTreatmentCode);
  if (!t) throw new Error(`Unknown VAT treatment: ${code}`);
  return t;
}

export function isTreatment(code: string): code is VatTreatmentCode {
  return BY_CODE.has(code as VatTreatmentCode);
}

/** Effective rate for a treatment in a given jurisdiction. */
export function treatmentRateBps(code: string, standardBps: number): number {
  const t = treatment(code);
  return t.rateBps === null ? standardBps : t.rateBps;
}

export interface JurisdictionVatRules {
  country: string;              // ISO-2
  inForce: boolean;
  standardBps: number;
  authority: string;
  authorityUrl: string;
  /** Mandatory registration threshold, as published. */
  registrationThreshold: string;
  /** Voluntary registration threshold, where one exists. */
  voluntaryThreshold: string;
  filing: string;
  /** Supplies taxed at 0% but still reportable, with input VAT recoverable. */
  zeroRated: readonly string[];
  /** Supplies with no VAT and NO input-VAT recovery. */
  exempt: readonly string[];
  /** Transactions outside the VAT system altogether. */
  outOfScope: readonly string[];
  /** Situations where the buyer self-accounts. */
  reverseCharge: readonly string[];
  /** Jurisdiction quirks a preparer will trip over. */
  exceptions: readonly string[];
}

/**
 * Per-jurisdiction catalogue. Category lists are the well-established headings
 * from each authority's own guidance — they are a preparer's checklist, not the
 * full statutory wording, and each entry should be checked against the source
 * before a filing position is taken.
 */
export const VAT_RULES: Readonly<Record<string, JurisdictionVatRules>> = {
  SA: {
    country: 'SA', inForce: true, standardBps: 1500,
    authority: 'ZATCA — Zakat, Tax and Customs Authority',
    authorityUrl: 'https://zatca.gov.sa',
    registrationThreshold: 'SAR 375,000 of annual taxable supplies',
    voluntaryThreshold: 'SAR 187,500',
    filing: 'Monthly if annual supplies exceed SAR 40m, otherwise quarterly',
    zeroRated: [
      'Exports of goods outside the GCC territory',
      'Services supplied to a customer resident outside the GCC (subject to conditions)',
      'International transport of goods and passengers, and related supplies',
      'Qualifying means of transport (aircraft, vessels, trains) and related goods and services',
      'Medicines and qualifying medical goods on the MoH / SFDA list',
      'Qualifying investment metals — gold, silver and platinum of 99% purity or more, tradable on a global market',
    ],
    exempt: [
      'Financial services where the consideration is an implicit margin (interest, life insurance) — explicit fee-based services are standard-rated',
      'Lease or licence of residential real estate',
    ],
    outOfScope: [
      'Supplies of real estate subject to the 5% Real Estate Transaction Tax (RETT) instead of VAT',
      'Supplies made by a person who is not, and need not be, VAT-registered',
    ],
    reverseCharge: [
      'Services imported by a taxable person from a non-resident supplier — the buyer accounts for output VAT and claims the matching input VAT',
    ],
    exceptions: [
      'The standard rate rose from 5% to 15% on 1 July 2020 — entries dated before that must carry the old rate, not today\'s.',
      'Residential rent is exempt, but a lease of commercial property is standard-rated. The distinction is the property\'s use, not the landlord.',
      'Zero-rating an export needs evidence the goods left the GCC; without documentation ZATCA can reassess at 15%.',
      'Fee-based financial services are standard-rated even at a bank whose interest income is exempt — mixed activity forces input-VAT apportionment.',
      'E-invoicing (Fatoora) Phase 2 requires clearance or reporting of every invoice with a previous-invoice hash chain, per wave.',
    ],
  },
  AE: {
    country: 'AE', inForce: true, standardBps: 500,
    authority: 'FTA — Federal Tax Authority',
    authorityUrl: 'https://tax.gov.ae',
    registrationThreshold: 'AED 375,000 of annual taxable supplies',
    voluntaryThreshold: 'AED 187,500',
    filing: 'Quarterly, or monthly for larger taxable persons as assigned by the FTA',
    zeroRated: [
      'Exports of goods and services outside the GCC implementing states',
      'International transport of passengers and goods, and related supplies',
      'Qualifying means of transport (air, sea and land) supplied for commercial use',
      'Investment precious metals — gold, silver and platinum of 99% purity or more',
      'First supply of a new residential building within three years of completion',
      'First supply of a building intended for a charity, or of a converted residential building',
      'Crude oil and natural gas',
      'Qualifying educational services by a qualifying institution, and related goods and services',
      'Preventive and basic healthcare services, and related goods and services',
    ],
    exempt: [
      'Financial services supplied for an implicit margin rather than an explicit fee',
      'Supply and lease of residential buildings other than the zero-rated first supply',
      'Supply of bare land',
      'Local passenger transport',
    ],
    outOfScope: [
      'Supplies of goods within, or between, Designated Zones — treated as made outside the UAE for VAT on goods',
      'Transactions between members of the same VAT group',
    ],
    reverseCharge: [
      'Imports of goods and services by a taxable person',
      'Domestic supplies of gold, diamonds and related products between registered businesses, where the conditions are met',
      'Domestic supplies of certain hydrocarbons and electronic devices between registered businesses',
    ],
    exceptions: [
      'A Designated Zone is a concession for GOODS only. Services supplied in a Designated Zone are treated as onshore and standard-rated — the single most common free-zone error.',
      'Education and healthcare are zero-rated in the UAE but treated differently in other Gulf states — do not carry a UAE position across a border.',
      'Higher education is only zero-rated where the institution is owned or funded by federal or local government; otherwise it is standard-rated.',
      'The UAE also levies 9% corporate tax on profits above AED 375,000 — a separate return from VAT, on a separate cycle.',
    ],
  },
  BH: {
    country: 'BH', inForce: true, standardBps: 1000,
    authority: 'NBR — National Bureau for Revenue',
    authorityUrl: 'https://www.nbr.gov.bh',
    registrationThreshold: 'BHD 37,500 of annual taxable supplies',
    voluntaryThreshold: 'BHD 18,750',
    filing: 'Monthly above BHD 3m of annual supplies, otherwise quarterly',
    zeroRated: [
      'Exports of goods and services outside the GCC implementing states',
      'International transport of goods and passengers, and related supplies',
      'Basic food items on the NBR published list',
      'Construction of new buildings',
      'Oil, gas and derivative hydrocarbons',
      'Education services and related goods and services, from pre-school to higher education',
      'Healthcare services and related goods and services, and qualifying medicines and medical equipment',
      'Investment gold, silver and platinum of 99% purity or more, and pearls and precious stones',
    ],
    exempt: [
      'Financial services supplied for an implicit margin',
      'Sale and lease of real estate, including bare land and buildings',
    ],
    outOfScope: [
      'Supplies by a person below the mandatory threshold and not registered',
    ],
    reverseCharge: [
      'Imports of goods and services by a taxable person from a non-resident supplier',
    ],
    exceptions: [
      'The standard rate doubled from 5% to 10% on 1 January 2022 — comparatives and prior-period entries must use 5%.',
      'Bahrain zero-rates basic food, construction, education and healthcare, where Saudi Arabia standard-rates most of them. This is the widest divergence in the GCC.',
      'No general corporate income tax; a 46% rate applies to hydrocarbon activity only.',
      'BHD is a three-decimal currency (1,000 fils) — rounding at two decimals silently misstates VAT.',
    ],
  },
  OM: {
    country: 'OM', inForce: true, standardBps: 500,
    authority: 'OTA — Oman Tax Authority',
    authorityUrl: 'https://tms.taxoman.gov.om',
    registrationThreshold: 'OMR 38,500 of annual taxable supplies',
    voluntaryThreshold: 'OMR 19,250',
    filing: 'Quarterly',
    zeroRated: [
      'Basic food items on the OTA published list',
      'Medicines and medical equipment',
      'Investment gold, silver and platinum',
      'Exports of goods and services outside the GCC implementing states',
      'International transport of goods and passengers, and related supplies',
      'Supply of crude oil, oil derivatives and natural gas',
      'Qualifying means of transport, and rescue aircraft and vessels',
    ],
    exempt: [
      'Financial services supplied for an implicit margin',
      'Healthcare services and related goods and services',
      'Education services and related goods and services',
      'Undeveloped bare land',
      'Resale of residential property and the lease of property for residential purposes',
      'Local passenger transport',
    ],
    outOfScope: [
      'Supplies by a person below the mandatory threshold and not registered',
    ],
    reverseCharge: [
      'Imports of goods and services by a taxable person from a non-resident supplier',
    ],
    exceptions: [
      'Healthcare and education are EXEMPT in Oman but ZERO-RATED in the UAE and Bahrain. Exempt kills input-VAT recovery; zero-rated does not. Same sector, opposite cash outcome.',
      'A 10% withholding tax applies to royalties, management fees and certain services paid to non-residents — separate from VAT.',
      'OMR is a three-decimal currency (1,000 baisa).',
    ],
  },
  QA: {
    country: 'QA', inForce: false, standardBps: 0,
    authority: 'GTA — General Tax Authority',
    authorityUrl: 'https://www.gta.gov.qa',
    registrationThreshold: 'Not applicable — VAT is not in force',
    voluntaryThreshold: 'Not applicable',
    filing: 'Not applicable',
    zeroRated: [], exempt: [], outOfScope: [],
    reverseCharge: [],
    exceptions: [
      'Qatar has signed the GCC VAT Framework Agreement but has not brought VAT into force. Do not post VAT on Qatari supplies without a legislative change.',
      'Excise tax does apply — 100% on tobacco and energy drinks, 50% on carbonated drinks.',
      'Corporate income tax is 10%, with 5% withholding on interest and royalties paid to non-residents.',
    ],
  },
  KW: {
    country: 'KW', inForce: false, standardBps: 0,
    authority: 'Ministry of Finance / Department of Inspection and Tax Claims',
    authorityUrl: 'https://www.mof.gov.kw',
    registrationThreshold: 'Not applicable — VAT is not in force',
    voluntaryThreshold: 'Not applicable',
    filing: 'Not applicable',
    zeroRated: [], exempt: [], outOfScope: [],
    reverseCharge: [],
    exceptions: [
      'Kuwait has signed the GCC VAT Framework Agreement but has not brought VAT into force. Do not post VAT on Kuwaiti supplies without a legislative change.',
      'Corporate income tax of 15% applies to foreign-owned entities; Zakat / NLST of roughly 1% of net profit applies to listed and Kuwaiti shareholding companies.',
      'KWD is a three-decimal currency (1,000 fils).',
    ],
  },
};

export function vatRules(countryId: string | undefined): JurisdictionVatRules {
  return VAT_RULES[countryId ?? 'SA'] ?? VAT_RULES.SA!;
}

/** Treatments a preparer can legitimately pick in a given jurisdiction. */
export function availableTreatments(countryId: string | undefined): VatTreatment[] {
  const r = vatRules(countryId);
  if (!r.inForce) return TREATMENTS.filter((t) => t.code === 'out_of_scope');
  return [...TREATMENTS];
}
