import { Position } from '../exchanges/types.js';
import { Decimal } from '../utils/decimal.js';
export interface ExposureStatus {
    totalAggregateNotionalUsd: Decimal;
    netDeltaUsd: Decimal;
    binanceNotionalUsd: Decimal;
    bybitNotionalUsd: Decimal;
    openPositionCount: number;
}
export declare class ExposureManager {
    static calculateExposure(binancePositions: Position[], bybitPositions: Position[]): ExposureStatus;
}
//# sourceMappingURL=exposure-manager.d.ts.map