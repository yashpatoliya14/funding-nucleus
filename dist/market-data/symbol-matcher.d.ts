import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { InstrumentInfo } from '../exchanges/types.js';
import { DbSymbolMapping } from '../persistence/models.js';
import { Decimal } from '../utils/decimal.js';
export interface MatchedPair {
    normalizedSymbol: string;
    binanceInstrument: InstrumentInfo;
    bybitInstrument: InstrumentInfo;
    contractMultiplier: Decimal;
    minQuantity: Decimal;
    quantityStep: Decimal;
    priceTick: Decimal;
}
export declare class SymbolMatcher {
    private binanceClient;
    private bybitClient;
    constructor(binanceClient: IExchangeClient, bybitClient: IExchangeClient);
    matchInstruments(): Promise<MatchedPair[]>;
    static toDbMapping(pair: MatchedPair, ttlHours?: number): DbSymbolMapping;
}
//# sourceMappingURL=symbol-matcher.d.ts.map