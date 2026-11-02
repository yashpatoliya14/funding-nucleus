import { AppConfig } from '../config/schema.js';
import { DailySummaryRepository, RiskEventRepository, TradeRepository } from '../persistence/repositories.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { KillSwitch } from './kill-switch.js';
import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { EvaluatedOpportunity } from '../strategy/opportunity-filter.js';
export declare class RiskManager {
    private binanceClient;
    private bybitClient;
    private tradeRepo;
    private dailyRepo;
    private riskRepo;
    private circuitBreaker;
    private killSwitch;
    private config;
    constructor(binanceClient: IExchangeClient, bybitClient: IExchangeClient, tradeRepo: TradeRepository, dailyRepo: DailySummaryRepository, riskRepo: RiskEventRepository, circuitBreaker: CircuitBreaker, killSwitch: KillSwitch, config: AppConfig);
    validatePreTrade(candidate: EvaluatedOpportunity): Promise<void>;
}
//# sourceMappingURL=risk-manager.d.ts.map