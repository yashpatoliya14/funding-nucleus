import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { ScannedOpportunity } from '../market-data/funding-scanner.js';
import { SizingResult } from './position-sizing.js';
import { ProfitabilityResult } from './profitability-engine.js';
import { AppConfig } from '../config/schema.js';
import { FundingHistoryService, SevenDayFundingStats } from '../analytics/funding-history.service.js';
export interface EvaluatedOpportunity {
    opportunity: ScannedOpportunity;
    sizing: SizingResult;
    profitability: ProfitabilityResult;
    isApproved: boolean;
    rejectionReason?: string;
    sevenDayStats?: SevenDayFundingStats | null;
    carryPotentialScore?: number;
}
export declare class OpportunityFilter {
    private binanceClient;
    private bybitClient;
    private config;
    private historyService?;
    constructor(binanceClient: IExchangeClient, bybitClient: IExchangeClient, config: AppConfig, historyService?: FundingHistoryService | undefined);
    evaluateOpportunity(opp: ScannedOpportunity): Promise<EvaluatedOpportunity>;
}
//# sourceMappingURL=opportunity-filter.d.ts.map