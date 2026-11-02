import { Decimal } from '../utils/decimal.js';
import { InstrumentInfo } from '../exchanges/types.js';
export interface SizingResult {
    binanceQuantity: Decimal;
    bybitQuantity: Decimal;
    binanceActualNotionalUsd: Decimal;
    bybitActualNotionalUsd: Decimal;
    notionalMismatchPct: Decimal;
    appliedLeverage: number;
}
export declare class PositionSizer {
    static calculateSizing(targetNotionalUsd: Decimal | string | number, binancePrice: Decimal | string | number, bybitPrice: Decimal | string | number, binanceInst: InstrumentInfo, bybitInst: InstrumentInfo, defaultLeverageCap?: number, maxMismatchPct?: Decimal | string | number): SizingResult;
}
//# sourceMappingURL=position-sizing.d.ts.map