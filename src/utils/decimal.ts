import { Decimal } from 'decimal.js';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

export function toDecimal(value: string | number | Decimal): Decimal {
  if (value instanceof Decimal) return value;
  return new Decimal(value);
}

export function roundToStep(value: Decimal | string | number, stepSize: Decimal | string | number): Decimal {
  const v = toDecimal(value);
  const s = toDecimal(stepSize);
  if (s.isZero()) return v;
  return v.dividedBy(s).floor().times(s);
}

export function roundToTick(value: Decimal | string | number, tickSize: Decimal | string | number): Decimal {
  const v = toDecimal(value);
  const t = toDecimal(tickSize);
  if (t.isZero()) return v;
  return v.dividedBy(t).round().times(t);
}

export function formatDecimal(value: Decimal | string | number, dp?: number): string {
  const d = toDecimal(value);
  return dp !== undefined ? d.toFixed(dp) : d.toString();
}

export function minDecimal(a: Decimal | string | number, b: Decimal | string | number): Decimal {
  const da = toDecimal(a);
  const db = toDecimal(b);
  return da.lessThan(db) ? da : db;
}

export function maxDecimal(a: Decimal | string | number, b: Decimal | string | number): Decimal {
  const da = toDecimal(a);
  const db = toDecimal(b);
  return da.greaterThan(db) ? da : db;
}
