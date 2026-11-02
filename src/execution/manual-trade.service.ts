import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { SymbolCache } from '../market-data/symbol-cache.js';
import { ExecutionEngine } from './execution-engine.js';
import { TelegramNotifier } from '../notifications/telegram.js';
import { PositionSizer } from '../strategy/position-sizing.js';
import { ProfitabilityEngine } from '../strategy/profitability-engine.js';
import { EvaluatedOpportunity } from '../strategy/opportunity-filter.js';
import { ScannedOpportunity } from '../market-data/funding-scanner.js';
import { Decimal, toDecimal } from '../utils/decimal.js';
import { AppConfig } from '../config/schema.js';
import { logger } from '../utils/logger.js';

export interface ManualTradeRequest {
  symbol: string; // e.g. "AKEUSDT" or "AKE"
  marginUsd: number; // e.g. 10, 25, 50, 100
}

export interface ManualTradeResult {
  success: boolean;
  tradeId?: string;
  symbol: string;
  marginUsd: number;
  leverage: number; // Always 5
  notionalUsd: number;
  direction: string;
  binanceRatePct: number;
  bybitRatePct: number;
  spreadPct: number;
  expectedNetProfitUsd: number;
  targetFundingTimeMs: number;
  message?: string;
}

export class ManualTradeService {
  constructor(
    private binanceClient: IExchangeClient,
    private bybitClient: IExchangeClient,
    private symbolCache: SymbolCache,
    private executionEngine: ExecutionEngine,
    private telegram: TelegramNotifier,
    private config: AppConfig
  ) {}

  /**
   * Executes a manual arbitrage trade on a specific pair at STRICTLY 5x leverage.
   */
  async executeManualTrade(
    request: ManualTradeRequest,
    isSimulated: boolean = false
  ): Promise<ManualTradeResult> {
    const rawSymbol = request.symbol.trim().toUpperCase();
    const marginUsd = Math.max(1, request.marginUsd || 10);
    const leverage = 5; // STRICT REQUIREMENT: Always 5x leverage
    const targetNotional = toDecimal(marginUsd).times(leverage);

    logger.info(
      { rawSymbol, marginUsd, leverage, targetNotional: targetNotional.toString() },
      'Received manual trade request at fixed 5x leverage'
    );

    // 1. Locate matched symbol mapping
    const allMappings = this.symbolCache.getAllActive();
    const mapping = allMappings.find(
      (m) =>
        m.normalized_symbol.toUpperCase() === rawSymbol ||
        m.binance_symbol.toUpperCase() === rawSymbol ||
        m.bybit_symbol.toUpperCase() === rawSymbol ||
        m.binance_symbol.toUpperCase() === `${rawSymbol}USDT` ||
        m.bybit_symbol.toUpperCase() === `${rawSymbol}USDT`
    );

    if (!mapping) {
      throw new Error(`Symbol "${rawSymbol}" is not active or matched across Binance & Bybit`);
    }

    const bSymbol = mapping.binance_symbol;
    const bySymbol = mapping.bybit_symbol;
    const coin = mapping.normalized_symbol;

    // 2. Fetch live rates, orderbooks, commission rates & instruments concurrently
    const [
      bRates,
      byRates,
      bBook,
      byBook,
      bCommissions,
      byCommissions,
      bInsts,
      byInsts,
      bBalances,
      byBalances,
    ] = await Promise.all([
      this.binanceClient.getFundingRates(),
      this.bybitClient.getFundingRates(),
      this.binanceClient.getOrderBook(bSymbol, 50),
      this.bybitClient.getOrderBook(bySymbol, 50),
      this.binanceClient.getCommissionRates(bSymbol),
      this.bybitClient.getCommissionRates(bySymbol),
      this.binanceClient.getInstruments(),
      this.bybitClient.getInstruments(),
      this.binanceClient.getBalances(),
      this.bybitClient.getBalances(),
    ]);

    const bRateInfo = bRates.find((r) => r.symbol === bSymbol);
    const byRateInfo = byRates.find((r) => r.symbol === bySymbol);

    if (!bRateInfo || !byRateInfo) {
      throw new Error(`Could not query live funding rates for ${coin}`);
    }

    const bInst = bInsts.find((i) => i.symbol === bSymbol);
    const byInst = byInsts.find((i) => i.symbol === bySymbol);

    if (!bInst || !byInst) {
      throw new Error(`Could not locate contract specifications for ${coin}`);
    }

    // 3. Margin availability check
    const bUsdtBal = bBalances.find((b) => b.asset === 'USDT')?.availableBalance ?? toDecimal('0');
    const byUsdtBal = byBalances.find((b) => b.asset === 'USDT')?.availableBalance ?? toDecimal('0');
    const requiredMarginPerLeg = toDecimal(marginUsd);

    if (bUsdtBal.lessThan(requiredMarginPerLeg)) {
      throw new Error(
        `Insufficient Binance available margin: $${bUsdtBal.toFixed(2)} USDT < required $${requiredMarginPerLeg.toFixed(2)} USDT`
      );
    }
    if (byUsdtBal.lessThan(requiredMarginPerLeg)) {
      throw new Error(
        `Insufficient Bybit available margin: $${byUsdtBal.toFixed(2)} USDT < required $${requiredMarginPerLeg.toFixed(2)} USDT`
      );
    }

    // 4. Direction & Spread
    const diff = bRateInfo.fundingRate.minus(byRateInfo.fundingRate);
    const diffPct = diff.times('100');
    const direction = diff.greaterThanOrEqualTo('0')
      ? ('SHORT_BINANCE_LONG_BYBIT' as const)
      : ('LONG_BINANCE_SHORT_BYBIT' as const);

    // 5. Position Sizing strictly using 5x leverage
    const sizing = PositionSizer.calculateSizing(
      targetNotional,
      bRateInfo.markPrice,
      byRateInfo.markPrice,
      { ...bInst, maxLeverage: 5 },
      { ...byInst, maxLeverage: 5 },
      5, // lock leverage cap to 5
      this.config.execution.maximum_notional_mismatch_pct
    );

    // 6. Profitability calculation
    const profitability = ProfitabilityEngine.evaluate(
      {
        binanceRate: bRateInfo.fundingRate,
        bybitRate: byRateInfo.fundingRate,
        binanceNotionalUsd: sizing.binanceActualNotionalUsd,
        bybitNotionalUsd: sizing.bybitActualNotionalUsd,
        binanceQuantity: sizing.binanceQuantity,
        bybitQuantity: sizing.bybitQuantity,
        binanceCommission: bCommissions,
        bybitCommission: byCommissions,
        binanceOrderBook: bBook,
        bybitOrderBook: byBook,
        riskBufferUsd: toDecimal(this.config.strategy.risk_buffer_usd || '0.05'),
      },
      toDecimal(this.config.strategy.minimum_net_profit_usd || '0.01')
    );

    const targetFundingTimeMs = Math.min(bRateInfo.fundingTimeMs, byRateInfo.fundingTimeMs);

    const opp: ScannedOpportunity = {
      mapping,
      binanceRate: bRateInfo.fundingRate,
      bybitRate: byRateInfo.fundingRate,
      fundingDiffPct: diffPct.abs(),
      fundingDirection: direction,
      binanceFundingTimeMs: bRateInfo.fundingTimeMs,
      bybitFundingTimeMs: byRateInfo.fundingTimeMs,
      targetFundingTimeMs,
      binanceMarkPrice: bRateInfo.markPrice,
      bybitMarkPrice: byRateInfo.markPrice,
      isAligned: true,
      binanceIntervalHours: bRateInfo.fundingIntervalHours ?? 8,
      bybitIntervalHours: byRateInfo.fundingIntervalHours ?? 8,
    };

    const evaluated: EvaluatedOpportunity = {
      opportunity: opp,
      sizing,
      profitability,
      isApproved: true,
    };

    const biQty = sizing.binanceQuantity.toFixed(4);
    const byQty = sizing.bybitQuantity.toFixed(4);
    const biNotional = sizing.binanceActualNotionalUsd.toFixed(2);
    const byNotional = sizing.bybitActualNotionalUsd.toFixed(2);
    const netProfitUsd = profitability.expectedNetProfitUsd.toFixed(4);
    const grossFunding = profitability.netFundingCashFlow.toFixed(4);
    const totalFees = profitability.estimatedEntryFees.plus(profitability.estimatedExitFees).toFixed(4);

    // 7. Send Telegram Execution Broadcast
    const alertMsg = [
      `⚡ *5X FUNDING ARBITRAGE TRADE INITIATED* ⚡`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🎯 *Pair:* \`${coin}\` (\`5x Leverage Locked\`)`,
      `🔄 *Direction:* \`${direction}\``,
      `💵 *Margin per Leg:* \`$${marginUsd.toFixed(2)} USDT\``,
      `⚖️ *Notional per Leg:* \`$${biNotional} USDT\` (Target: $${targetNotional.toFixed(2)})`,
      ``,
      `📊 *Order Details:*`,
      `• Binance: \`${direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'SHORT (SELL)' : 'LONG (BUY)'} ${biQty} ${coin}\` (~$${biNotional})`,
      `• Bybit: \`${direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'LONG (BUY)' : 'SHORT (SELL)'} ${byQty} ${coin}\` (~$${byNotional})`,
      ``,
      `💰 *Profit Forecast:*`,
      `• Gross Funding: \`+$${grossFunding} USDT\``,
      `• Est. Taker Fees: \`-$${totalFees} USDT\``,
      `• Expected Net PnL: \`+$${netProfitUsd} USDT\``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🚀 *Executing simultaneous market orders now. Engine will monitor and close post-settlement.*`
    ].join('\n');

    try {
      await this.telegram.sendMessage(alertMsg);
    } catch {}

    // 8. Wait for the exchange lifecycle so callers receive the actual order result.
    const executedTrade = await this.executionEngine.executeTrade(evaluated, isSimulated);
    if (executedTrade.state === 'FAILED' || executedTrade.state === 'ABORT_AND_FLATTEN') {
      throw new Error(executedTrade.error_message || `Trade execution failed for ${coin}`);
    }

    return {
      success: true,
      tradeId: `trade-manual-${Date.now()}`,
      symbol: coin,
      marginUsd,
      leverage: 5,
      notionalUsd: parseFloat(biNotional),
      direction,
      binanceRatePct: parseFloat((Number(bRateInfo.fundingRate) * 100).toFixed(4)),
      bybitRatePct: parseFloat((Number(byRateInfo.fundingRate) * 100).toFixed(4)),
      spreadPct: parseFloat(diffPct.abs().toFixed(4)),
      expectedNetProfitUsd: parseFloat(netProfitUsd),
      targetFundingTimeMs,
      message: `Simultaneous 5x arbitrage trade initiated for ${coin} ($${marginUsd} margin / $${biNotional} notional per leg). Engine will collect funding and exit flat post-settlement.`,
    };
  }
}
