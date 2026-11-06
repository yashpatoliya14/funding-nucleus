import { Decimal } from 'decimal.js';
Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });
export { Decimal };
export function toDecimal(value) {
    if (value === undefined || value === null)
        return new Decimal('0');
    if (value instanceof Decimal)
        return value;
    return new Decimal(value);
}
export function roundToStep(value, stepSize) {
    const v = toDecimal(value);
    const s = toDecimal(stepSize);
    if (s.isZero())
        return v;
    return v.dividedBy(s).floor().times(s);
}
export function roundToTick(value, tickSize) {
    const v = toDecimal(value);
    const t = toDecimal(tickSize);
    if (t.isZero())
        return v;
    return v.dividedBy(t).round().times(t);
}
export function formatDecimal(value, dp) {
    const d = toDecimal(value);
    return dp !== undefined ? d.toFixed(dp) : d.toString();
}
export function minDecimal(a, b) {
    const da = toDecimal(a);
    const db = toDecimal(b);
    return da.lessThan(db) ? da : db;
}
export function maxDecimal(a, b) {
    const da = toDecimal(a);
    const db = toDecimal(b);
    return da.greaterThan(db) ? da : db;
}
//# sourceMappingURL=decimal.js.map