import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { DbSymbolMapping } from '../persistence/models.js';
import { Decimal } from '../utils/decimal.js';
export interface ScannedOpportunity {
    mapping: DbSymbolMapping;
    binanceRate: Decimal;
    bybitRate: Decimal;
    fundingDiffPct: Decimal;
    fundingDirection: 'SHORT_BINANCE_LONG_BYBIT' | 'LONG_BINANCE_SHORT_BYBIT';
    binanceFundingTimeMs: number;
    bybitFundingTimeMs: number;
    targetFundingTimeMs: number;
    binanceMarkPrice: Decimal;
    bybitMarkPrice: Decimal;
    isAligned: boolean;
    binanceIntervalHours: number;
    bybitIntervalHours: number;
}
export declare class FundingScanner {
    private binanceClient;
    private bybitClient;
    private requireAligned;
    private alignmentToleranceSec;
    constructor(binanceClient: IExchangeClient, bybitClient: IExchangeClient, requireAligned?: boolean, alignmentToleranceSec?: number);
    scanOpportunities(activeMappings: DbSymbolMapping[]): Promise<ScannedOpportunity[]>;
}
//# sourceMappingURL=funding-scanner.d.ts.map