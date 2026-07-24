/**
 * Money — exact integer arithmetic in minor units (centavos).
 *
 * RULE (non-negotiable): money is NEVER a float. A single rounding error in a
 * ledger is a credibility-ending event. We store centavos as bigint and only
 * convert to a display string at the edge.
 */

export type Money = bigint; // centavos

/** Build Money from a peso amount (number). 1234.56 pesos -> 123456 centavos. */
export function pesos(amount: number): Money {
  // Guard against float drift by rounding at the boundary.
  return BigInt(Math.round(amount * 100));
}

/** Build Money directly from centavos. */
export function centavos(n: number | bigint): Money {
  return BigInt(n);
}

export const ZERO: Money = 0n;

/**
 * Apply a rate expressed in basis points (1% = 100 bps) with half-up rounding
 * to the nearest centavo. e.g. IVA 19% = 1900 bps, retefuente 2.5% = 250 bps.
 */
export function applyRateBps(base: Money, bps: number): Money {
  const b = BigInt(bps);
  const sign = base < 0n ? -1n : 1n;
  const abs = base < 0n ? -base : base;
  // round half up
  const scaled = abs * b + 5000n;
  return sign * (scaled / 10000n);
}

export function addAll(values: Money[]): Money {
  return values.reduce((s, v) => s + v, 0n);
}

export function abs(m: Money): Money {
  return m < 0n ? -m : m;
}

/** Format centavos as Colombian pesos, e.g. 6000000000n -> "$60.000.000,00". */
export function formatCOP(m: Money, withCents = false): string {
  const sign = m < 0n ? '-' : '';
  const absVal = m < 0n ? -m : m;
  const wholePesos = absVal / 100n;
  const cents = absVal % 100n;
  const grouped = wholePesos
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return withCents
    ? `${sign}$${grouped},${cents.toString().padStart(2, '0')}`
    : `${sign}$${grouped}`;
}

/** Convert to a JSON-safe number of pesos (for reports/UI only, never for math). */
export function toPesosNumber(m: Money): number {
  return Number(m) / 100;
}
