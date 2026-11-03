import { PositionSizer } from './position-sizing.js';
import { ProfitabilityEngine } from './profitability-engine.js';
import { toDecimal } from '../utils/decimal.js';
import { logger } from '../utils/logger.js';
export class OpportunityFilter {
    binanceClient;
    bybitClient;
    config;
    historyService;
    constructor(binanceClient, bybitClient, config, historyService) {
        this.binanceClient = binanceClient;
        this.bybitClient = bybitClient;
        this.config = config;
        this.historyService = historyService;
    }
    async evaluateOpportunity(opp) {
        const symbol = opp.mapping.normalized_symbol;
        // Check minimum funding edge requirement
        const minEdge = toDecimal(this.config.strategy.minimum_funding_edge_pct);
        if (opp.fundingDiffPct.lessThan(minEdge)) {
            return {
                opportunity: opp,
                sizing: {},
                profitability: {},
                isApproved: false,
                rejectionReason: `Funding edge ${opp.fundingDiffPct.toFixed(4)}% is below minimum required ${minEdge.toFixed(4)}%`,
            };
        }
        try {
            // 1. Fetch current order books (depth: 50 for robust slippage estimation) and commission rates concurrently
            const [binanceBook, bybitBook, binanceCommission, bybitCommission, binanceBalances, bybitBalances, binanceInsts, bybitInsts] = await Promise.all([
                this.binanceClient.getOrderBook(opp.mapping.binance_symbol, 50),
                this.bybitClient.getOrderBook(opp.mapping.bybit_symbol, 50),
                this.binanceClient.getCommissionRates(opp.mapping.binance_symbol),
                this.bybitClient.getCommissionRates(opp.mapping.bybit_symbol),
                this.binanceClient.getBalances(),
                this.bybitClient.getBalances(),
                this.binanceClient.getInstruments(),
                this.bybitClient.getInstruments(),
            ]);
            const bInst = binanceInsts.find((i) => i.symbol === opp.mapping.binance_symbol);
            const byInst = bybitInsts.find((i) => i.symbol === opp.mapping.bybit_symbol);
            if (!bInst || !byInst) {
                return {
                    opportunity: opp,
                    sizing: {},
                    profitability: {},
                    isApproved: false,
                    rejectionReason: 'Contract specification not found for matched symbols',
                };
            }
            // 1b. Orderbook bid-ask spread & liquidity check (Item 7: reject illiquid or blown-out order books)
            const maxBookSpreadPct = this.config.strategy.max_orderbook_spread_pct ?? 0.20;
            const bBid = binanceBook.bids[0]?.price;
            const bAsk = binanceBook.asks[0]?.price;
            const byBid = bybitBook.bids[0]?.price;
            const byAsk = bybitBook.asks[0]?.price;
            if (bBid && bAsk && !bBid.isZero()) {
                const bSpreadPct = bAsk.minus(bBid).dividedBy(bBid).times(100).toNumber();
                if (bSpreadPct > maxBookSpreadPct) {
                    return {
                        opportunity: opp,
                        sizing: {},
                        profitability: {},
                        isApproved: false,
                        rejectionReason: `Binance order book spread ${bSpreadPct.toFixed(3)}% is too wide (> ${maxBookSpreadPct}%)`,
                    };
                }
            }
            if (byBid && byAsk && !byBid.isZero()) {
                const bySpreadPct = byAsk.minus(byBid).dividedBy(byBid).times(100).toNumber();
                if (bySpreadPct > maxBookSpreadPct) {
                    return {
                        opportunity: opp,
                        sizing: {},
                        profitability: {},
                        isApproved: false,
                        rejectionReason: `Bybit order book spread ${bySpreadPct.toFixed(3)}% is too wide (> ${maxBookSpreadPct}%)`,
                    };
                }
            }
            // 1c. Flash Mirage & Rate Stability Filter (Item 7: Filter out flash liquidation mirages)
            let stats = null;
            let carryScore = 50;
            if (this.historyService) {
                try {
                    stats = await this.historyService.getSevenDayFundingHistory(opp.mapping.binance_symbol, opp.mapping.bybit_symbol, symbol);
                    if (stats && stats.settlementCount >= 3) {
                        carryScore = stats.consistencyScorePct;
                        if (this.config.strategy.flash_mirage_filter_enabled) {
                            const minConsistency = this.config.strategy.min_historical_consistency_pct ?? 50.0;
                            if (stats.consistencyScorePct < minConsistency) {
                                return {
                                    opportunity: opp,
                                    sizing: {},
                                    profitability: {},
                                    isApproved: false,
                                    rejectionReason: `Flash rate mirage: low 7-day edge consistency (${stats.consistencyScorePct.toFixed(1)}% < ${minConsistency}%)`,
                                };
                            }
                            const oppDir = opp.fundingDirection;
                            if (stats.dominantDirection !== oppDir && stats.consistencyScorePct >= 65) {
                                return {
                                    opportunity: opp,
                                    sizing: {},
                                    profitability: {},
                                    isApproved: false,
                                    rejectionReason: `Flash rate inversion: current direction ${oppDir} opposes persistent 7-day trend (${stats.dominantDirection})`,
                                };
                            }
                        }
                    }
                }
                catch (histErr) {
                    logger.debug({ symbol, err: histErr?.message }, 'Could not retrieve 7-day stats for stability check, proceeding with live rates');
                }
            }
            // 2. Query dynamic maximum leverage for this specific coin directly from both exchanges
            let bMaxLev = bInst.maxLeverage || 20;
            let byMaxLev = byInst.maxLeverage || 25;
            const [liveBLev, liveByLev] = await Promise.allSettled([
                this.binanceClient.getMaxLeverage ? this.binanceClient.getMaxLeverage(opp.mapping.binance_symbol) : Promise.resolve(bMaxLev),
                this.bybitClient.getMaxLeverage ? this.bybitClient.getMaxLeverage(opp.mapping.bybit_symbol) : Promise.resolve(byMaxLev),
            ]);
            if (liveBLev.status === 'fulfilled' && liveBLev.value > 0) {
                bMaxLev = liveBLev.value;
            }
            if (liveByLev.status === 'fulfilled' && liveByLev.value > 0) {
                byMaxLev = liveByLev.value;
            }
            const dynamicBInst = { ...bInst, maxLeverage: bMaxLev };
            const dynamicByInst = { ...byInst, maxLeverage: byMaxLev };
            // Common maximum leverage determined dynamically from both exchanges for this specific coin
            const effectiveLeverage = Math.min(dynamicBInst.maxLeverage, dynamicByInst.maxLeverage, this.config.risk.default_leverage_cap || 100);
            // Sizing is dynamically driven by your desired USDT margin:
            // Target Notional = Margin (default $10) * Common Maximum Dynamic Leverage
            const marginPerLeg = toDecimal(this.config.risk.trade_margin_per_leg_usd || 10);
            const targetNotional = marginPerLeg.times(effectiveLeverage);
            // Position sizing using the dynamic common leverage min(Binance coin max, Bybit coin max)
            const sizing = PositionSizer.calculateSizing(targetNotional, opp.binanceMarkPrice, opp.bybitMarkPrice, dynamicBInst, dynamicByInst, this.config.risk.default_leverage_cap || 100, this.config.execution.maximum_notional_mismatch_pct);
            // 3. Margin availability check
            const bUsdtBal = binanceBalances.find((b) => b.asset === 'USDT')?.availableBalance ?? toDecimal('0');
            const byUsdtBal = bybitBalances.find((b) => b.asset === 'USDT')?.availableBalance ?? toDecimal('0');
            const bRequiredMargin = sizing.binanceActualNotionalUsd.dividedBy(sizing.appliedLeverage);
            const byRequiredMargin = sizing.bybitActualNotionalUsd.dividedBy(sizing.appliedLeverage);
            if (bUsdtBal.lessThan(bRequiredMargin)) {
                return {
                    opportunity: opp,
                    sizing,
                    profitability: {},
                    isApproved: false,
                    rejectionReason: `Binance available margin $${bUsdtBal.toFixed(2)} is less than required $${bRequiredMargin.toFixed(2)}`,
                };
            }
            if (byUsdtBal.lessThan(byRequiredMargin)) {
                return {
                    opportunity: opp,
                    sizing,
                    profitability: {},
                    isApproved: false,
                    rejectionReason: `Bybit available margin $${byUsdtBal.toFixed(2)} is less than required $${byRequiredMargin.toFixed(2)}`,
                };
            }
            // 4. Profitability calculation
            const profitability = ProfitabilityEngine.evaluate({
                binanceRate: opp.binanceRate,
                bybitRate: opp.bybitRate,
                binanceNotionalUsd: sizing.binanceActualNotionalUsd,
                bybitNotionalUsd: sizing.bybitActualNotionalUsd,
                binanceQuantity: sizing.binanceQuantity,
                bybitQuantity: sizing.bybitQuantity,
                binanceCommission,
                bybitCommission,
                binanceOrderBook: binanceBook,
                bybitOrderBook: bybitBook,
                riskBufferUsd: toDecimal(this.config.strategy.risk_buffer_usd),
            }, toDecimal(this.config.strategy.minimum_net_profit_usd));
            if (!profitability.isProfitable || profitability.expectedNetProfitUsd.lessThanOrEqualTo(0)) {
                return {
                    opportunity: opp,
                    sizing,
                    profitability,
                    isApproved: false,
                    rejectionReason: profitability.expectedNetProfitUsd.lessThanOrEqualTo(0)
                        ? `Expected net profit ($${profitability.expectedNetProfitUsd.toFixed(4)}) is negative or zero`
                        : (profitability.rejectionReason || 'Profit below threshold'),
                };
            }
            return {
                opportunity: opp,
                sizing,
                profitability,
                isApproved: true,
                sevenDayStats: stats,
                carryPotentialScore: carryScore,
            };
        }
        catch (err) {
            logger.warn({ err: err?.message, symbol }, 'Opportunity evaluation failed');
            return {
                opportunity: opp,
                sizing: {},
                profitability: {},
                isApproved: false,
                rejectionReason: err?.message || 'Unknown evaluation error',
            };
        }
    }
}
//# sourceMappingURL=opportunity-filter.js.map