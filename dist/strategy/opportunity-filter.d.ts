import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { ScannedOpportunity } from '../market-data/funding-scanner.js';
import { SizingResult } from './position-sizing.js';
import { ProfitabilityResult } from './profitability-engine.js';
import { AppConfig } from '../config/schema.js';
export interface EvaluatedOpportunity {
    opportunity: ScannedOpportunity;
    sizing: SizingResult;
    profitability: ProfitabilityResult;
    isApproved: boolean;
    rejectionReason?: string;
}
export declare class OpportunityFilter {
    private binanceClient;
    private bybitClient;
    private config;
    constructor(binanceClient: IExchangeClient, bybitClient: IExchangeClient, config: AppConfig);
    evaluateOpportunity(opp: ScannedOpportunity): Promise<EvaluatedOpportunity>;
}
//# sourceMappingURL=opportunity-filter.d.ts.map