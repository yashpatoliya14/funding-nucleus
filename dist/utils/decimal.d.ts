import { Decimal } from 'decimal.js';
export { Decimal };
export declare function toDecimal(value: string | number | Decimal): Decimal;
export declare function roundToStep(value: Decimal | string | number, stepSize: Decimal | string | number): Decimal;
export declare function roundToTick(value: Decimal | string | number, tickSize: Decimal | string | number): Decimal;
export declare function formatDecimal(value: Decimal | string | number, dp?: number): string;
export declare function minDecimal(a: Decimal | string | number, b: Decimal | string | number): Decimal;
export declare function maxDecimal(a: Decimal | string | number, b: Decimal | string | number): Decimal;
//# sourceMappingURL=decimal.d.ts.map