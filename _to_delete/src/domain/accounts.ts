/**
 * Chart of accounts — aligned to the Colombian PUC (Plan Único de Cuentas).
 * `normal` is the side that increases the account (D = debit, C = credit).
 */

export type AccountType =
  | 'activo'
  | 'pasivo'
  | 'patrimonio'
  | 'ingreso'
  | 'gasto'
  | 'costo';

export type NormalSide = 'D' | 'C';

export interface Account {
  code: string;
  name: string;
  type: AccountType;
  normal: NormalSide;
}

export const CHART_OF_ACCOUNTS: readonly Account[] = [
  { code: '110505', name: 'Caja general', type: 'activo', normal: 'D' },
  { code: '111005', name: 'Bancos — cuenta corriente', type: 'activo', normal: 'D' },
  { code: '130505', name: 'Clientes nacionales', type: 'activo', normal: 'D' },
  { code: '135515', name: 'IVA descontable', type: 'activo', normal: 'D' },
  { code: '143505', name: 'Inventario de mercancías', type: 'activo', normal: 'D' },
  { code: '220505', name: 'Proveedores nacionales', type: 'pasivo', normal: 'C' },
  { code: '240805', name: 'IVA generado por pagar (19%)', type: 'pasivo', normal: 'C' },
  { code: '236540', name: 'Retención en la fuente por pagar', type: 'pasivo', normal: 'C' },
  { code: '310505', name: 'Capital social', type: 'patrimonio', normal: 'C' },
  { code: '413505', name: 'Ingresos por ventas', type: 'ingreso', normal: 'C' },
  { code: '513505', name: 'Gastos de administración', type: 'gasto', normal: 'D' },
  { code: '523505', name: 'Gastos de ventas', type: 'gasto', normal: 'D' },
  { code: '613505', name: 'Costo de mercancía vendida', type: 'costo', normal: 'D' },
] as const;

const BY_CODE = new Map(CHART_OF_ACCOUNTS.map((a) => [a.code, a]));

export function getAccount(code: string): Account {
  const a = BY_CODE.get(code);
  if (!a) throw new Error(`Cuenta desconocida en el PUC: ${code}`);
  return a;
}

export function accountExists(code: string): boolean {
  return BY_CODE.has(code);
}
