import { AppConfig } from '../config/schema.js';
import { DailySummaryRepository, RiskEventRepository, TradeRepository } from '../persistence/repositories.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { KillSwitch } from './kill-switch.js';
import { ExposureManager } from './exposure-manager.js';
import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { EvaluatedOpportunity } from '../strategy/opportunity-filter.js';
import { Decimal, toDecimal } from '../utils/decimal.js';
import { RiskLimitViolationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export class RiskManager {
  constructor(
    private binanceClient: IExchangeClient,
    private bybitClient: IExchangeClient,
    private tradeRepo: TradeRepository,
    private dailyRepo: DailySummaryRepository,
    private riskRepo: RiskEventRepository,
    private circuitBreaker: CircuitBreaker,
    private killSwitch: KillSwitch,
    private config: AppConfig
  ) {}

  async validatePreTrade(candidate: EvaluatedOpportunity): Promise<void> {
    const coin = candidate.opportunity.mapping.normalized_symbol;

    // 1. Kill Switch Check
    if (this.killSwitch.isEngaged()) {
      throw new RiskLimitViolationError('KILL_SWITCH', `Kill switch is engaged: ${this.killSwitch.getReason()}`);
    }

    // 2. Circuit Breaker Check
    if (this.circuitBreaker.isTripped()) {
      throw new RiskLimitViolationError('CIRCUIT_BREAKER', `Circuit breaker is tripped: ${this.circuitBreaker.getReason()}`);
    }

    // 3. Daily Loss Limit Check
    const dailySummary = this.dailyRepo.getOrCreateToday();
    const currentNetPnl = toDecimal(dailySummary.net_pnl_usd);
    const maxDailyLoss = toDecimal(this.config.risk.maximum_daily_loss_usd);

    if (currentNetPnl.isNegative() && currentNetPnl.abs().greaterThanOrEqualTo(maxDailyLoss)) {
      this.circuitBreaker.trip(`Daily loss limit reached ($${currentNetPnl.toFixed(2)} <= -$${maxDailyLoss.toFixed(2)})`);
      throw new RiskLimitViolationError('DAILY_LOSS_LIMIT', `Daily loss limit of $${maxDailyLoss.toFixed(2)} reached`);
    }

    // 4. Concurrent Active Trades Check
    const activeTrades = this.tradeRepo.getActiveTrades();
    if (activeTrades.length >= this.config.risk.maximum_concurrent_trades) {
      throw new RiskLimitViolationError(
        'MAX_CONCURRENT_TRADES',
        `Active trades count (${activeTrades.length}) reached limit (${this.config.risk.maximum_concurrent_trades})`
      );
    }

    // 5. Existing trade on same coin or funding event check
    const duplicateCoin = activeTrades.some((t) => t.coin === coin);
    if (duplicateCoin) {
      throw new RiskLimitViolationError('DUPLICATE_COIN_TRADE', `An active trade for ${coin} is already in progress`);
    }

    // 6. Aggregate Notional Check
    const [bPos, byPos] = await Promise.all([
      this.binanceClient.getPositions(),
      this.bybitClient.getPositions(),
    ]);

    const exposure = ExposureManager.calculateExposure(bPos, byPos);
    const candidateNotional = candidate.sizing.binanceActualNotionalUsd.plus(candidate.sizing.bybitActualNotionalUsd);
    const projectedTotalNotional = exposure.totalAggregateNotionalUsd.plus(candidateNotional);
    const maxAggregate = toDecimal(this.config.risk.maximum_aggregate_notional_usd);

    if (projectedTotalNotional.greaterThan(maxAggregate)) {
      throw new RiskLimitViolationError(
        'MAX_AGGREGATE_NOTIONAL',
        `Projected aggregate notional $${projectedTotalNotional.toFixed(2)} exceeds maximum allowed $${maxAggregate.toFixed(2)}`
      );
    }

    logger.info({ coin, projectedTotalNotional: projectedTotalNotional.toFixed(2) }, 'Pre-trade risk checks passed');
  }
}
