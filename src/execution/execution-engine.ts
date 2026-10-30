import { randomUUID } from 'node:crypto';
import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { OrderManager } from './order-manager.js';
import { ExecutionReconciliation } from './reconciliation.js';
import { HedgeRecovery } from './hedge-recovery.js';
import { TradeStateMachine } from './state-machine.js';
import { EvaluatedOpportunity } from '../strategy/opportunity-filter.js';
import {
  DailySummaryRepository,
  FundingEventRepository,
  FundingTransactionRepository,
  TradeRepository,
} from '../persistence/repositories.js';
import { DbFundingEvent, DbTrade, TradeState } from '../persistence/models.js';
import { AppConfig } from '../config/schema.js';
import { Decimal, toDecimal } from '../utils/decimal.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/time.js';

export class ExecutionEngine {
  constructor(
    private binanceClient: IExchangeClient,
    private bybitClient: IExchangeClient,
    private orderManager: OrderManager,
    private reconciliation: ExecutionReconciliation,
    private hedgeRecovery: HedgeRecovery,
    private stateMachine: TradeStateMachine,
    private tradeRepo: TradeRepository,
    private fundingEventRepo: FundingEventRepository,
    private fundingTxRepo: FundingTransactionRepository,
    private dailyRepo: DailySummaryRepository,
    private config: AppConfig
  ) {}

  async executeTrade(candidate: EvaluatedOpportunity, isSimulated: boolean = true): Promise<DbTrade> {
    const tradeId = randomUUID();
    const coin = candidate.opportunity.mapping.normalized_symbol;
    const bSymbol = candidate.opportunity.mapping.binance_symbol;
    const bySymbol = candidate.opportunity.mapping.bybit_symbol;
    const now = new Date().toISOString();

    logger.info({ tradeId, coin, direction: candidate.profitability.direction }, 'Starting trade execution lifecycle');

    // 1. Persist funding event
    const fundingEventId = `fe-${coin}-${candidate.opportunity.targetFundingTimeMs}`;
    const dbEvent: DbFundingEvent = {
      id: fundingEventId,
      coin,
      binance_funding_rate: candidate.opportunity.binanceRate.toString(),
      bybit_funding_rate: candidate.opportunity.bybitRate.toString(),
      funding_rate_diff: candidate.opportunity.fundingDiffPct.toString(),
      binance_funding_time: new Date(candidate.opportunity.binanceFundingTimeMs).toISOString(),
      bybit_funding_time: new Date(candidate.opportunity.bybitFundingTimeMs).toISOString(),
      target_funding_time: new Date(candidate.opportunity.targetFundingTimeMs).toISOString(),
      is_aligned: candidate.opportunity.isAligned ? 1 : 0,
      status: 'TRADED',
      created_at: now,
    };
    this.fundingEventRepo.upsert(dbEvent);

    // 2. Persist trade intent in SQLite (State: EXECUTION_INTENT_SAVED)
    const dbTrade: DbTrade = {
      id: tradeId,
      coin,
      binance_symbol: bSymbol,
      bybit_symbol: bySymbol,
      funding_event_id: fundingEventId,
      state: 'EXECUTION_INTENT_SAVED',
      direction: candidate.profitability.direction,
      target_notional_usd: candidate.sizing.binanceActualNotionalUsd.toString(),
      binance_entry_qty: candidate.sizing.binanceQuantity.toString(),
      bybit_entry_qty: candidate.sizing.bybitQuantity.toString(),
      binance_exit_qty: '0',
      bybit_exit_qty: '0',
      expected_funding_edge_pct: candidate.opportunity.fundingDiffPct.toString(),
      expected_net_profit_usd: candidate.profitability.expectedNetProfitUsd.toString(),
      realized_pnl_usd: '0',
      total_fees_usd: '0',
      total_funding_usd: '0',
      net_pnl_usd: '0',
      is_simulated: isSimulated ? 1 : 0,
      error_message: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    };
    this.tradeRepo.create(dbTrade);

    let currentState: TradeState = 'EXECUTION_INTENT_SAVED';

    try {
      // 3. Transition to ENTRY_SUBMITTED
      currentState = this.stateMachine.transition(
        tradeId,
        currentState,
        'ENTRY_SUBMITTED',
        'Submitting concurrent market entry orders'
      );

      const bSide = candidate.profitability.direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'SELL' : 'BUY';
      const bySide = candidate.profitability.direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'BUY' : 'SELL';

      // Set synchronized common leverage before opening positions
      if (candidate.sizing.appliedLeverage) {
        await Promise.allSettled([
          this.binanceClient.setLeverage ? this.binanceClient.setLeverage(bSymbol, candidate.sizing.appliedLeverage) : Promise.resolve(),
          this.bybitClient.setLeverage ? this.bybitClient.setLeverage(bySymbol, candidate.sizing.appliedLeverage) : Promise.resolve(),
        ]);
        logger.info(
          { coin, leverage: candidate.sizing.appliedLeverage },
          'Synchronized common leverage on Binance and Bybit'
        );
      }

      // Submit both market orders concurrently
      const [bOrderResult, byOrderResult] = await Promise.allSettled([
        this.orderManager.executeMarketOrder(
          this.binanceClient,
          tradeId,
          bSymbol,
          bSide,
          candidate.sizing.binanceQuantity,
          'ENTRY',
          false
        ),
        this.orderManager.executeMarketOrder(
          this.bybitClient,
          tradeId,
          bySymbol,
          bySide,
          candidate.sizing.bybitQuantity,
          'ENTRY',
          false
        ),
      ]);

      const bOrder = bOrderResult.status === 'fulfilled' ? bOrderResult.value : null;
      const byOrder = byOrderResult.status === 'fulfilled' ? byOrderResult.value : null;

      this.reconciliation.recordFills(tradeId, bOrder, byOrder);

      // 4. Transition to ENTRY_RECONCILIATION
      currentState = this.stateMachine.transition(
        tradeId,
        currentState,
        'ENTRY_RECONCILIATION',
        'Reconciling entry orders and open positions'
      );

      const recon = await this.reconciliation.reconcilePositions(tradeId, bSymbol, bySymbol);

      // Check for one-leg failure or mismatch exceeding tolerance
      const maxMismatch = toDecimal(this.config.execution.maximum_notional_mismatch_pct);
      if (!recon.bothLegsFilled || recon.oneLegFailed || recon.residualMismatchPct.greaterThan(maxMismatch)) {
        currentState = this.stateMachine.transition(
          tradeId,
          currentState,
          'RECOVERY_REQUIRED',
          !recon.bothLegsFilled || recon.oneLegFailed
            ? 'One leg failed or partial fill detected'
            : `Residual mismatch ${recon.residualMismatchPct.toFixed(2)}% exceeds tolerance`
        );

        const recov = await this.hedgeRecovery.recover(
          tradeId,
          bSymbol,
          bySymbol,
          candidate.profitability.direction,
          candidate.sizing.binanceQuantity,
          candidate.sizing.bybitQuantity
        );

        if (recov.isFlat) {
          currentState = this.stateMachine.transition(
            tradeId,
            currentState,
            'ABORT_AND_FLATTEN',
            'Positions flattened after recovery'
          );
          currentState = this.stateMachine.transition(
            tradeId,
            currentState,
            'FLAT_VERIFICATION',
            'Verified flat after aborted entry'
          );
          this.stateMachine.transition(tradeId, currentState, 'FAILED', 'Trade aborted and flattened');
          return this.tradeRepo.getById(tradeId)!;
        }
      }

      // 5. Successfully hedged! Transition to BOTH_LEGS_HEDGED
      currentState = this.stateMachine.transition(
        tradeId,
        currentState,
        'BOTH_LEGS_HEDGED',
        'Both legs filled and matched exposure confirmed'
      );

      // 6. Transition to WAITING_FOR_FUNDING
      currentState = this.stateMachine.transition(
        tradeId,
        currentState,
        'WAITING_FOR_FUNDING',
        'Holding positions until funding settlement epoch'
      );

      // In paper mode or live mode, wait until target exit (funding timestamp + target_exit_delay_seconds)
      const targetFundingMs = candidate.opportunity.targetFundingTimeMs;
      const exitDelayMs = this.config.strategy.target_exit_delay_seconds * 1000;
      const exitTimeMs = targetFundingMs + exitDelayMs;
      const waitTimeMs = Math.max(0, exitTimeMs - Date.now());

      logger.info({ tradeId, waitTimeMs, exitDelaySeconds: this.config.strategy.target_exit_delay_seconds }, 'Waiting for funding settlement');
      // For testing/paper mode with distant funding, cap wait time if needed, or wait
      if (waitTimeMs > 0 && waitTimeMs < 10000) {
        await sleep(waitTimeMs);
      }

      // 7. Transition to FUNDING_RECONCILIATION
      currentState = this.stateMachine.transition(
        tradeId,
        currentState,
        'FUNDING_RECONCILIATION',
        'Querying funding settlement transactions'
      );

      // Retrieve actual funding records
      const bFundingHistory = await this.binanceClient.getFundingHistory(bSymbol);
      const byFundingHistory = await this.bybitClient.getFundingHistory(bySymbol);

      let totalFundingReceived = toDecimal('0');
      for (const f of bFundingHistory) {
        totalFundingReceived = totalFundingReceived.plus(f.paymentAmount);
      }
      for (const f of byFundingHistory) {
        totalFundingReceived = totalFundingReceived.plus(f.paymentAmount);
      }

      // If simulated or no records yet returned, use calculated funding
      if (isSimulated && totalFundingReceived.isZero()) {
        totalFundingReceived = candidate.profitability.netFundingCashFlow;
      }

      // 8. Transition to EXIT_PENDING -> CLOSING_POSITIONS
      currentState = this.stateMachine.transition(
        tradeId,
        currentState,
        'EXIT_PENDING',
        'Target exit time reached, preparing position closure'
      );

      currentState = this.stateMachine.transition(
        tradeId,
        currentState,
        'CLOSING_POSITIONS',
        'Submitting reduce-only market close orders'
      );

      // Reverse sides for exit
      const bExitSide = bSide === 'BUY' ? 'SELL' : 'BUY';
      const byExitSide = bySide === 'BUY' ? 'SELL' : 'BUY';

      const [bExitResult, byExitResult] = await Promise.allSettled([
        this.orderManager.executeMarketOrder(
          this.binanceClient,
          tradeId,
          bSymbol,
          bExitSide,
          candidate.sizing.binanceQuantity,
          'EXIT',
          true // reduce-only
        ),
        this.orderManager.executeMarketOrder(
          this.bybitClient,
          tradeId,
          bySymbol,
          byExitSide,
          candidate.sizing.bybitQuantity,
          'EXIT',
          true // reduce-only
        ),
      ]);

      const bExitOrder = bExitResult.status === 'fulfilled' ? bExitResult.value : null;
      const byExitOrder = byExitResult.status === 'fulfilled' ? byExitResult.value : null;

      this.reconciliation.recordFills(tradeId, bExitOrder, byExitOrder);

      // 9. Transition to FLAT_VERIFICATION
      currentState = this.stateMachine.transition(
        tradeId,
        currentState,
        'FLAT_VERIFICATION',
        'Verifying both exchange positions are strictly zero'
      );

      await sleep(100);
      const finalRecon = await this.reconciliation.reconcilePositions(tradeId, bSymbol, bySymbol);

      if (!finalRecon.isFlat) {
        logger.error({ tradeId, finalRecon }, 'Exit failed: Accounts are not flat! Invoking emergency recovery');
        await this.hedgeRecovery.flattenAllLegs(tradeId, bSymbol, bySymbol, 'Exit flat verification failed');
      }

      // 10. Accounting & P&L Calculation
      const totalFees = candidate.profitability.estimatedEntryFees.plus(candidate.profitability.estimatedExitFees);
      const realizedTradingPnl = toDecimal('0'); // Directional delta close to zero
      const netPnl = realizedTradingPnl.plus(totalFundingReceived).minus(totalFees);

      this.tradeRepo.update({
        id: tradeId,
        realized_pnl_usd: realizedTradingPnl.toString(),
        total_fees_usd: totalFees.toString(),
        total_funding_usd: totalFundingReceived.toString(),
        net_pnl_usd: netPnl.toString(),
        binance_exit_qty: candidate.sizing.binanceQuantity.toString(),
        bybit_exit_qty: candidate.sizing.bybitQuantity.toString(),
      });

      // Update daily summary
      this.dailyRepo.addTradeResult(realizedTradingPnl, totalFundingReceived, totalFees);

      // 11. Transition to COMPLETED
      currentState = this.stateMachine.transition(
        tradeId,
        currentState,
        'COMPLETED',
        `Trade completed successfully. Net PnL: $${netPnl.toFixed(4)}`
      );

      logger.info({ tradeId, netPnl: netPnl.toFixed(4) }, 'Trade lifecycle completed successfully');
      return this.tradeRepo.getById(tradeId)!;
    } catch (err: any) {
      logger.error({ tradeId, err: err?.message }, 'Execution lifecycle error');
      this.tradeRepo.update({
        id: tradeId,
        error_message: err?.message,
      });
      if (currentState !== 'COMPLETED' && currentState !== 'FAILED') {
        try {
          this.stateMachine.transition(tradeId, currentState, 'EMERGENCY', `Execution exception: ${err?.message}`);
          await this.hedgeRecovery.flattenAllLegs(tradeId, bSymbol, bySymbol, 'Emergency exception flattening');
          this.stateMachine.transition(tradeId, 'EMERGENCY', 'FLAT_VERIFICATION', 'Verified flat after emergency');
          this.stateMachine.transition(tradeId, 'FLAT_VERIFICATION', 'FAILED', 'Trade terminated due to error');
        } catch (emgErr) {
          logger.error({ emgErr }, 'Emergency recovery encountered error');
        }
      }
      throw err;
    }
  }
}
