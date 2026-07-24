/**
 * Chart of accounts — IFRS-based, for the Saudi Arabia (KSA) market.
 *
 * Codes are semantic constants (ACCT.*) so the rest of the system never hard-codes
 * a chart. Swapping localization (KSA / another market) is a change to this file
 * alone. Names carry English + Arabic.
 */

export type AccountType =
  | 'asset'
  | 'liability'
  | 'equity'
  | 'revenue'
  | 'expense'
  | 'cogs';

export type NormalSide = 'D' | 'C';

/** Semantic account codes — reference these everywhere, never string literals. */
export const ACCT = {
  CASH: '1000',
  BANK: '1010',
  AR: '1100',
  INPUT_VAT: '1150',      // recoverable input VAT
  WHT_RECEIVABLE: '1160', // withholding tax in our favor
  INVENTORY: '1200',
  PPE: '1500',
  AP: '2000',
  OUTPUT_VAT: '2100',     // VAT collected on sales, payable to ZATCA
  WHT_PAYABLE: '2110',    // withholding tax we owe
  CAPITAL: '3000',
  REVENUE: '4000',
  COGS: '5000',
  ADMIN_EXP: '6000',
  SELLING_EXP: '6100',
} as const;

export interface Account {
  code: string;
  name: string;
  nameAr: string;
  type: AccountType;
  normal: NormalSide;
}

export const CHART_OF_ACCOUNTS: readonly Account[] = [
  { code: ACCT.CASH, name: 'Cash on hand', nameAr: 'النقد في الصندوق', type: 'asset', normal: 'D' },
  { code: ACCT.BANK, name: 'Bank', nameAr: 'البنك', type: 'asset', normal: 'D' },
  { code: ACCT.AR, name: 'Accounts receivable', nameAr: 'الذمم المدينة', type: 'asset', normal: 'D' },
  { code: ACCT.INPUT_VAT, name: 'Input VAT (recoverable)', nameAr: 'ضريبة القيمة المضافة على المدخلات', type: 'asset', normal: 'D' },
  { code: ACCT.WHT_RECEIVABLE, name: 'Withholding tax receivable', nameAr: 'ضريبة الاستقطاع المستحقة لنا', type: 'asset', normal: 'D' },
  { code: ACCT.INVENTORY, name: 'Inventory', nameAr: 'المخزون', type: 'asset', normal: 'D' },
  { code: ACCT.PPE, name: 'Property, plant & equipment', nameAr: 'الممتلكات والمعدات', type: 'asset', normal: 'D' },
  { code: ACCT.AP, name: 'Accounts payable', nameAr: 'الذمم الدائنة', type: 'liability', normal: 'C' },
  { code: ACCT.OUTPUT_VAT, name: 'Output VAT (payable)', nameAr: 'ضريبة القيمة المضافة على المخرجات', type: 'liability', normal: 'C' },
  { code: ACCT.WHT_PAYABLE, name: 'Withholding tax payable', nameAr: 'ضريبة الاستقطاع المستحقة', type: 'liability', normal: 'C' },
  { code: ACCT.CAPITAL, name: 'Share capital', nameAr: 'رأس المال', type: 'equity', normal: 'C' },
  { code: ACCT.REVENUE, name: 'Revenue', nameAr: 'الإيرادات', type: 'revenue', normal: 'C' },
  { code: ACCT.COGS, name: 'Cost of goods sold', nameAr: 'تكلفة البضاعة المباعة', type: 'cogs', normal: 'D' },
  { code: ACCT.ADMIN_EXP, name: 'General & administrative expenses', nameAr: 'مصاريف عمومية وإدارية', type: 'expense', normal: 'D' },
  { code: ACCT.SELLING_EXP, name: 'Selling & distribution expenses', nameAr: 'مصاريف بيع وتوزيع', type: 'expense', normal: 'D' },
] as const;

const BY_CODE = new Map(CHART_OF_ACCOUNTS.map((a) => [a.code, a]));

export function getAccount(code: string): Account {
  const a = BY_CODE.get(code);
  if (!a) throw new Error(`Unknown account: ${code}`);
  return a;
}

export function accountExists(code: string): boolean {
  return BY_CODE.has(code);
}

/** Cash & bank accounts, for reconciliation and cash-flow. */
export const CASH_AND_BANK: readonly string[] = [ACCT.CASH, ACCT.BANK];
