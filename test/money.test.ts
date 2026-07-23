import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { pesos, applyRateBps, formatCOP, ZERO, addAll } from '../src/domain/money.js';

describe('money — exact integer arithmetic', () => {
  it('pesos() converts to centavos without float drift', () => {
    expect(pesos(1234.56)).toBe(123456n);
    expect(pesos(0.1) + pesos(0.2)).toBe(pesos(0.3)); // the classic float trap, avoided
    expect(pesos(60_000_000)).toBe(6_000_000_000n);
  });

  it('applyRateBps rounds half-up to the centavo', () => {
    // 19% of 100.00 pesos = 19.00
    expect(applyRateBps(pesos(100), 1900)).toBe(pesos(19));
    // 2.5% of 950,000 pesos = 23,750.00
    expect(applyRateBps(pesos(950_000), 250)).toBe(pesos(23_750));
    // rounding: 19% of 0.01 pesos (1 centavo) = 0.0019 -> rounds to 0.00
    expect(applyRateBps(1n, 1900)).toBe(0n);
    // 19% of 3 centavos = 0.57 -> 1 centavo
    expect(applyRateBps(3n, 1900)).toBe(1n);
  });

  it('formatCOP renders Colombian thousands separators', () => {
    expect(formatCOP(pesos(60_000_000))).toBe('$60.000.000');
    expect(formatCOP(pesos(1_234.5), true)).toBe('$1.234,50');
    expect(formatCOP(-pesos(500))).toBe('-$500');
  });

  it('addAll is associative and exact over many values', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -10_000_000, max: 10_000_000 }), { maxLength: 200 }), (nums) => {
        const asMoney = nums.map((n) => BigInt(n));
        const expected = nums.reduce((s, n) => s + n, 0);
        return addAll(asMoney) === BigInt(expected);
      }),
    );
  });

  it('ZERO is the additive identity', () => {
    expect(pesos(42) + ZERO).toBe(pesos(42));
  });
});
