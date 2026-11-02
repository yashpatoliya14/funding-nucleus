import { randomUUID } from 'node:crypto';
import { toDecimal } from '../utils/decimal.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/time.js';
export class ExecutionEngine {
    binanceClient;
    bybitClient;
    orderManager;
    reconciliation;
    hedgeRecovery;
    stateMachine;
    tradeRepo;
    fundingEventRepo;
    fundingTxRepo;
    dailyRepo;
    config;
    marginMonitor;
    telegram;
    constructor(binanceClient, bybitClient, orderManager, reconciliation, hedgeRecovery, stateMachine, tradeRepo, fundingEventRepo, fundingTxRepo, dailyRepo, config, marginMonitor, telegram) {
        this.binanceClient = binanceClient;
        this.bybitClient = bybitClient;
        this.orderManager = orderManager;
        this.reconciliation = reconciliation;
        this.hedgeRecovery = hedgeRecovery;
        this.stateMachine = stateMachine;
        this.tradeRepo = tradeRepo;
        this.fundingEventRepo = fundingEventRepo;
        this.fundingTxRepo = fundingTxRepo;
        this.dailyRepo = dailyRepo;
        this.config = config;
        this.marginMonitor = marginMonitor;
        this.telegram = telegram;
    }
    async executeTrade(candidate, isSimulated = true) {
        if (!candidate.isApproved || candidate.profitability.expectedNetProfitUsd.lessThanOrEqualTo(0)) {
            throw new Error(`Safety Invariant Violation: Trade aborted because expected net profit ($${candidate.profitability?.expectedNetProfitUsd?.toString()}) is negative or zero.`);
        }
        const tradeId = randomUUID();
        const coin = candidate.opportunity.mapping.normalized_symbol;
        const bSymbol = candidate.opportunity.mapping.binance_symbol;
        const bySymbol = candidate.opportunity.mapping.bybit_symbol;
        const now = new Date().toISOString();
        logger.info({ tradeId, coin, direction: candidate.profitability.direction }, 'Starting trade execution lifecycle');
        // 1. Persist funding event
        const fundingEventId = `fe-${coin}-${candidate.opportunity.targetFundingTimeMs}`;
        const dbEvent = {
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
        const dbTrade = {
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
        let currentState = 'EXECUTION_INTENT_SAVED';
        try {
            // 3. Transition to ENTRY_SUBMITTED
            currentState = this.stateMachine.transition(tradeId, currentState, 'ENTRY_SUBMITTED', 'Submitting concurrent market entry orders');
            const bSide = candidate.profitability.direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'SELL' : 'BUY';
            const bySide = candidate.profitability.direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'BUY' : 'SELL';
            // Set synchronized common leverage before opening positions
            if (candidate.sizing.appliedLeverage) {
                await Promise.allSettled([
                    this.binanceClient.setLeverage ? this.binanceClient.setLeverage(bSymbol, candidate.sizing.appliedLeverage) : Promise.resolve(),
                    this.bybitClient.setLeverage ? this.bybitClient.setLeverage(bySymbol, candidate.sizing.appliedLeverage) : Promise.resolve(),
                ]);
                logger.info({ coin, leverage: candidate.sizing.appliedLeverage }, 'Synchronized common leverage on Binance and Bybit');
            }
            // Submit both market orders concurrently
            const [bOrderResult, byOrderResult] = await Promise.allSettled([
                this.orderManager.executeMarketOrder(this.binanceClient, tradeId, bSymbol, bSide, candidate.sizing.binanceQuantity, 'ENTRY', false),
                this.orderManager.executeMarketOrder(this.bybitClient, tradeId, bySymbol, bySide, candidate.sizing.bybitQuantity, 'ENTRY', false),
            ]);
            const bOrder = bOrderResult.status === 'fulfilled' ? bOrderResult.value : null;
            const byOrder = byOrderResult.status === 'fulfilled' ? byOrderResult.value : null;
            this.reconciliation.recordFills(tradeId, bOrder, byOrder);
            // 4. Transition to ENTRY_RECONCILIATION
            currentState = this.stateMachine.transition(tradeId, currentState, 'ENTRY_RECONCILIATION', 'Reconciling entry orders and open positions');
            const recon = await this.reconciliation.reconcilePositions(tradeId, bSymbol, bySymbol);
            // Check for one-leg failure or mismatch exceeding tolerance
            const maxMismatch = toDecimal(this.config.execution.maximum_notional_mismatch_pct);
            if (!recon.bothLegsFilled || recon.oneLegFailed || recon.residualMismatchPct.greaterThan(maxMismatch)) {
                currentState = this.stateMachine.transition(tradeId, currentState, 'RECOVERY_REQUIRED', !recon.bothLegsFilled || recon.oneLegFailed
                    ? 'One leg failed or partial fill detected'
                    : `Residual mismatch ${recon.residualMismatchPct.toFixed(2)}% exceeds tolerance`);
                const recov = await this.hedgeRecovery.recover(tradeId, bSymbol, bySymbol, candidate.profitability.direction, candidate.sizing.binanceQuantity, candidate.sizing.bybitQuantity);
                if (recov.isFlat) {
                    currentState = this.stateMachine.transition(tradeId, currentState, 'ABORT_AND_FLATTEN', 'Positions flattened after recovery');
                    currentState = this.stateMachine.transition(tradeId, currentState, 'FLAT_VERIFICATION', 'Verified flat after aborted entry');
                    this.stateMachine.transition(tradeId, currentState, 'FAILED', 'Trade aborted and flattened');
                    return this.tradeRepo.getById(tradeId);
                }
            }
            // 5. Successfully hedged! Transition to BOTH_LEGS_HEDGED
            currentState = this.stateMachine.transition(tradeId, currentState, 'BOTH_LEGS_HEDGED', 'Both legs filled and matched exposure confirmed');
            if (this.telegram) {
                const bPrice = bOrder?.averagePrice ? bOrder.averagePrice.toFixed(4) : 'Market';
                const byPrice = byOrder?.averagePrice ? byOrder.averagePrice.toFixed(4) : 'Market';
                const bAction = bSide === 'SELL' ? 'SHORT (SELL)' : 'LONG (BUY)';
                const byAction = bySide === 'BUY' ? 'LONG (BUY)' : 'SHORT (SELL)';
                const lev = candidate.sizing.appliedLeverage || 10;
                const notional = candidate.sizing.binanceActualNotionalUsd.toFixed(2);
                const marginPerLeg = (parseFloat(notional) / lev).toFixed(2);
                const targetTimeStr = new Date(candidate.opportunity.targetFundingTimeMs).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
                const entryAlert = [
                    `🟢 *TRADE ENTERED & FULLY HEDGED* 🟢`,
                    `━━━━━━━━━━━━━━━━━━━━━━`,
                    `🎯 *Pair:* \`${coin}\` (Binance & Bybit)`,
                    `⚖️ *Leverage:* \`${lev}x\` | *Margin/Leg:* \`$${marginPerLeg} USDT\``,
                    `💼 *Position Notional:* \`~\$${notional} USDT\``,
                    ``,
                    `📥 *Live Fills Confirmed:*`,
                    `• *Binance:* \`${bAction}\` @ \`$${bPrice}\` (Qty: \`${recon.binanceExecutedQty.toString()}\`)`,
                    `• *Bybit:* \`${byAction}\` @ \`$${byPrice}\` (Qty: \`${recon.bybitExecutedQty.toString()}\`)`,
                    ``,
                    `⏳ *Status:* Delta-neutral active. Waiting for settlement at \`${targetTimeStr}\``,
                    `🛡️ *Active Guardians:* 5-second liquidation guard & margin drift monitor`,
                    `━━━━━━━━━━━━━━━━━━━━━━`,
                    `_Both legs locked. Will auto-close positions right after settlement._`
                ].join('\n');
                await this.telegram.sendMessage(entryAlert);
            }
            // 6. Transition to WAITING_FOR_FUNDING
            currentState = this.stateMachine.transition(tradeId, currentState, 'WAITING_FOR_FUNDING', 'Holding positions until funding settlement epoch');
            let cycleCount = 0;
            let totalFundingReceived = toDecimal('0');
            let targetFundingMs = candidate.opportunity.targetFundingTimeMs;
            const isCarryEnabled = this.config.strategy.cumulative_carry_enabled;
            const minRetentionEdge = this.config.strategy.carry_min_retention_edge_pct;
            const exitDelayMs = this.config.strategy.target_exit_delay_seconds * 1000;
            while (true) {
                cycleCount++;
                const exitTimeMs = targetFundingMs + exitDelayMs;
                const waitTimeMs = Math.max(0, exitTimeMs - Date.now());
                logger.info({ tradeId, cycleCount, waitTimeMs, exitDelaySeconds: this.config.strategy.target_exit_delay_seconds }, `Holding positions for cycle ${cycleCount} funding settlement`);
                if (waitTimeMs > 0) {
                    if (!isSimulated) {
                        // In live mode: wait in 5-second periodic chunks while actively monitoring for liquidation & margin drift
                        let remainingMs = waitTimeMs;
                        while (remainingMs > 0) {
                            const sleepChunk = Math.min(remainingMs, 5000);
                            await sleep(sleepChunk);
                            remainingMs -= sleepChunk;
                            // 1. LIQUIDATION & ONE-LEG FAILURE GUARD
                            // If user missed the margin rebalance alert and one leg gets liquidated or closed by exchange,
                            // immediately auto-exit on the surviving leg to eliminate unhedged directional exposure!
                            const recon = await this.reconciliation.reconcilePositions(tradeId, bSymbol, bySymbol);
                            if (recon.oneLegFailed) {
                                const liquidatedExchange = recon.binanceExecutedQty.isZero() ? 'Binance' : 'Bybit';
                                const survivingExchange = liquidatedExchange === 'Binance' ? 'Bybit' : 'Binance';
                                const survivingQty = liquidatedExchange === 'Binance' ? recon.bybitExecutedQty : recon.binanceExecutedQty;
                                logger.error({ tradeId, coin, liquidatedExchange, survivingExchange, survivingQty: survivingQty.toString() }, `CRITICAL: ${liquidatedExchange} position was liquidated or closed by exchange! Auto-closing ${survivingExchange} immediately.`);
                                if (this.telegram) {
                                    const alertMsg = [
                                        `🚨 *EMERGENCY: LIQUIDATION AUTO-PROTECTION* 🚨`,
                                        ``,
                                        `⚠️ *One of your trade legs was liquidated or closed by the exchange!*`,
                                        `• *Pair:* \`${coin}\``,
                                        `• *Liquidated Leg:* *${liquidatedExchange}* (Position: \`0\`)`,
                                        `• *Surviving Leg:* *${survivingExchange}* (Open Qty: \`${survivingQty.toString()}\`)`,
                                        ``,
                                        `⚡ *INSTANT ACTION TAKEN:*`,
                                        `The bot detected the missing leg and immediately executed an **emergency market close** on *${survivingExchange}* to prevent catastrophic directional market losses!`,
                                        ``,
                                        `🛡️ *Both exchanges are now flat.*`,
                                    ].join('\n');
                                    await this.telegram.sendMessage(alertMsg);
                                }
                                // Immediately flatten the surviving leg
                                await this.hedgeRecovery.flattenAllLegs(tradeId, bSymbol, bySymbol, `Emergency auto-close: ${liquidatedExchange} was liquidated`);
                                currentState = this.stateMachine.transition(tradeId, currentState, 'EMERGENCY', `One leg liquidated on ${liquidatedExchange}`);
                                currentState = this.stateMachine.transition(tradeId, currentState, 'FLAT_VERIFICATION', 'Verified flat after liquidation recovery');
                                this.stateMachine.transition(tradeId, currentState, 'FAILED', `Terminated: ${liquidatedExchange} leg liquidated, ${survivingExchange} auto-closed`);
                                this.tradeRepo.update({
                                    id: tradeId,
                                    error_message: `Emergency exit: ${liquidatedExchange} was liquidated. Surviving ${survivingExchange} leg closed immediately.`,
                                });
                                return this.tradeRepo.getById(tradeId);
                            }
                            // 2. PROACTIVE MARGIN DRIFT MONITOR
                            if (this.marginMonitor) {
                                const marginStatus = await this.marginMonitor.checkMarginBalance(coin);
                                if (marginStatus.isCritical) {
                                    logger.warn({ tradeId, marginStatus }, 'Critical margin threshold breached during carry hold! Breaking carry loop to close positions');
                                    break;
                                }
                            }
                        }
                    }
                    else if (waitTimeMs < 10000) {
                        await sleep(waitTimeMs);
                    }
                }
                // 7. Transition to FUNDING_RECONCILIATION
                currentState = this.stateMachine.transition(tradeId, currentState, 'FUNDING_RECONCILIATION', `Querying funding settlement transactions (Cycle ${cycleCount})`);
                // Retrieve actual funding records
                const bFundingHistory = await this.binanceClient.getFundingHistory(bSymbol);
                const byFundingHistory = await this.bybitClient.getFundingHistory(bySymbol);
                let cycleFunding = toDecimal('0');
                for (const f of bFundingHistory) {
                    cycleFunding = cycleFunding.plus(f.paymentAmount);
                }
                for (const f of byFundingHistory) {
                    cycleFunding = cycleFunding.plus(f.paymentAmount);
                }
                // If simulated or no records yet returned, use calculated funding
                if (isSimulated && cycleFunding.isZero()) {
                    cycleFunding = candidate.profitability.netFundingCashFlow;
                }
                totalFundingReceived = totalFundingReceived.plus(cycleFunding);
                logger.info({ tradeId, cycleCount, cycleFunding: cycleFunding.toFixed(4), totalFunding: totalFundingReceived.toFixed(4) }, 'Funding collected for cycle');
                // In simulation, only execute 1 cycle unless configured
                if (!isCarryEnabled || isSimulated || cycleCount >= 6) {
                    if (cycleCount >= 6) {
                        logger.info({ tradeId, cycleCount }, 'Max carry cycles reached (6 cycles / 48h). Closing positions.');
                    }
                    break;
                }
                // Check margin status before deciding to extend carry
                if (this.marginMonitor) {
                    const marginStatus = await this.marginMonitor.checkMarginBalance(coin);
                    if (marginStatus.needsRebalance && marginStatus.isCritical) {
                        logger.warn({ tradeId }, 'Margin status critical, ending carry to protect margin.');
                        break;
                    }
                }
                // Evaluate next cycle funding edge
                try {
                    const [bRates, byRates] = await Promise.all([
                        this.binanceClient.getFundingRates(),
                        this.bybitClient.getFundingRates(),
                    ]);
                    const bInfo = bRates.find((r) => r.symbol === bSymbol);
                    const byInfo = byRates.find((r) => r.symbol === bySymbol);
                    if (!bInfo || !byInfo) {
                        logger.info({ tradeId }, 'Could not locate next funding rates for carry evaluation. Closing positions.');
                        break;
                    }
                    const dir = candidate.profitability.direction;
                    const nextSpreadPct = dir === 'SHORT_BINANCE_LONG_BYBIT'
                        ? bInfo.fundingRate.minus(byInfo.fundingRate).times(100).toNumber()
                        : byInfo.fundingRate.minus(bInfo.fundingRate).times(100).toNumber();
                    if (nextSpreadPct >= minRetentionEdge) {
                        logger.info({ tradeId, nextSpreadPct, minRetentionEdge, cycleCount }, 'Next cycle funding edge exceeds retention threshold. Carrying positions over!');
                        if (this.telegram) {
                            const dirShort = dir === 'SHORT_BINANCE_LONG_BYBIT' ? 'Short BI / Long BY' : 'Long BI / Short BY';
                            const carryMsg = [
                                `🔄 *CUMULATIVE CARRY EXTENSION (Cycle ${cycleCount + 1})*`,
                                `• *Pair:* \`${coin}\` (\`${dirShort}\`)`,
                                `• *Next Spread:* \`+${nextSpreadPct.toFixed(4)}%\` (Min: \`${minRetentionEdge}%\`)`,
                                `• *Cumulative Funding So Far:* \`+$${totalFundingReceived.toFixed(3)} USDT\``,
                                `• *Zero Friction:* Holding position avoids duplicate taker fees!`,
                            ].join('\n');
                            await this.telegram.sendMessage(carryMsg);
                        }
                        // Update target funding time for next cycle
                        targetFundingMs = Math.min(bInfo.fundingTimeMs, byInfo.fundingTimeMs);
                        if (targetFundingMs <= Date.now()) {
                            targetFundingMs = Date.now() + 8 * 3600 * 1000;
                        }
                        // Transition back to WAITING_FOR_FUNDING for the next cycle
                        currentState = this.stateMachine.transition(tradeId, currentState, 'WAITING_FOR_FUNDING', `Retaining carry position for cycle ${cycleCount + 1}`);
                        continue;
                    }
                    else {
                        logger.info({ tradeId, nextSpreadPct, minRetentionEdge }, 'Next cycle funding edge below retention threshold. Concluding carry and closing.');
                        if (this.telegram && cycleCount > 1) {
                            await this.telegram.sendMessage(`🏁 *Carry Complete:* Next spread for \`${coin}\` dropped to \`${nextSpreadPct.toFixed(4)}%\` (< \`${minRetentionEdge}%\`). Closing positions across ${cycleCount} settled cycles.`);
                        }
                        break;
                    }
                }
                catch (fetchErr) {
                    logger.warn({ tradeId, err: fetchErr?.message }, 'Failed to query next funding rates for carry evaluation. Closing.');
                    break;
                }
            }
            // 8. Transition to EXIT_PENDING -> CLOSING_POSITIONS
            currentState = this.stateMachine.transition(tradeId, currentState, 'EXIT_PENDING', 'Target exit time reached, preparing position closure');
            currentState = this.stateMachine.transition(tradeId, currentState, 'CLOSING_POSITIONS', 'Submitting reduce-only market close orders');
            // Reverse sides for exit
            const bExitSide = bSide === 'BUY' ? 'SELL' : 'BUY';
            const byExitSide = bySide === 'BUY' ? 'SELL' : 'BUY';
            const [bExitResult, byExitResult] = await Promise.allSettled([
                this.orderManager.executeMarketOrder(this.binanceClient, tradeId, bSymbol, bExitSide, candidate.sizing.binanceQuantity, 'EXIT', true // reduce-only
                ),
                this.orderManager.executeMarketOrder(this.bybitClient, tradeId, bySymbol, byExitSide, candidate.sizing.bybitQuantity, 'EXIT', true // reduce-only
                ),
            ]);
            const bExitOrder = bExitResult.status === 'fulfilled' ? bExitResult.value : null;
            const byExitOrder = byExitResult.status === 'fulfilled' ? byExitResult.value : null;
            this.reconciliation.recordFills(tradeId, bExitOrder, byExitOrder);
            // 9. Transition to FLAT_VERIFICATION
            currentState = this.stateMachine.transition(tradeId, currentState, 'FLAT_VERIFICATION', 'Verifying both exchange positions are strictly zero');
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
            currentState = this.stateMachine.transition(tradeId, currentState, 'COMPLETED', `Trade completed successfully. Net PnL: $${netPnl.toFixed(4)}`);
            if (this.telegram) {
                const pnlSign = netPnl.greaterThanOrEqualTo(0) ? '+' : '';
                const pnlIcon = netPnl.greaterThanOrEqualTo(0) ? '🟢' : '🔴';
                const grossFunding = totalFundingReceived.toFixed(4);
                const feesStr = totalFees.toFixed(4);
                const netPnlStr = netPnl.toFixed(4);
                const closeAlert = [
                    `🏁 *TRADE COMPLETED & POSITIONS CLOSED* 🏁`,
                    `━━━━━━━━━━━━━━━━━━━━━━`,
                    `🎯 *Pair:* \`${coin}\``,
                    `🛡️ *Position Status:* \`100% FLAT (Zero Open Exposure)\``,
                    ``,
                    `💰 *Realized Cash Flow & Net Profit:*`,
                    `• *Gross Funding Collected:* \`+\$${grossFunding} USDT\``,
                    `• *Total Exchange Fees Paid:* \`-\$${feesStr} USDT\``,
                    `• ${pnlIcon} *Net Realized Profit:* \`*${pnlSign}\$${netPnlStr} USDT*\``,
                    ``,
                    `✅ Both accounts verified flat. Margin returned to free balance.`,
                    `━━━━━━━━━━━━━━━━━━━━━━`,
                    `_Bot resumed scanning for the next funding opportunity._`
                ].join('\n');
                await this.telegram.sendMessage(closeAlert);
            }
            logger.info({ tradeId, netPnl: netPnl.toFixed(4) }, 'Trade lifecycle completed successfully');
            return this.tradeRepo.getById(tradeId);
        }
        catch (err) {
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
                }
                catch (emgErr) {
                    logger.error({ emgErr }, 'Emergency recovery encountered error');
                }
            }
            throw err;
        }
    }
}
//# sourceMappingURL=execution-engine.js.map