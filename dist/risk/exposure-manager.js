import { toDecimal } from '../utils/decimal.js';
export class ExposureManager {
    static calculateExposure(binancePositions, bybitPositions) {
        let bNotional = toDecimal('0');
        let byNotional = toDecimal('0');
        let bSignedDelta = toDecimal('0');
        let bySignedDelta = toDecimal('0');
        let count = 0;
        for (const p of binancePositions) {
            if (p.quantity.isZero() || p.side === 'FLAT')
                continue;
            count++;
            const notional = p.quantity.times(p.markPrice);
            bNotional = bNotional.plus(notional);
            bSignedDelta = bSignedDelta.plus(p.side === 'LONG' ? notional : notional.negated());
        }
        for (const p of bybitPositions) {
            if (p.quantity.isZero() || p.side === 'FLAT')
                continue;
            count++;
            const notional = p.quantity.times(p.markPrice);
            byNotional = byNotional.plus(notional);
            bySignedDelta = bySignedDelta.plus(p.side === 'LONG' ? notional : notional.negated());
        }
        const totalAggregate = bNotional.plus(byNotional);
        const netDelta = bSignedDelta.plus(bySignedDelta);
        return {
            totalAggregateNotionalUsd: totalAggregate,
            netDeltaUsd: netDelta,
            binanceNotionalUsd: bNotional,
            bybitNotionalUsd: byNotional,
            openPositionCount: count,
        };
    }
}
//# sourceMappingURL=exposure-manager.js.map