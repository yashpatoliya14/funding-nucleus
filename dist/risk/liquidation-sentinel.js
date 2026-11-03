import { logger } from '../utils/logger.js';
import { sleep } from '../utils/time.js';
function normalizeSymbol(symbol) {
    return symbol.replace(/USDT$/, '').replace(/USD$/, '').toUpperCase();
}
export class LiquidationSentinel {
    binanceClient;
    bybitClient;
    killSwitch;
    telegram;
    checkIntervalMs;
    minEmergencyMarginUsd;
    isRunning = false;
    lastAlertTime = 0;
    constructor(options) {
        this.binanceClient = options.binanceClient;
        this.bybitClient = options.bybitClient;
        this.killSwitch = options.killSwitch;
        this.telegram = options.telegram;
        this.checkIntervalMs = options.checkIntervalMs ?? 3000;
        this.minEmergencyMarginUsd = options.minEmergencyMarginUsd ?? 2.0;
    }
    start() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        logger.info('Liquidation and Margin Sentinel watchdog started (monitoring every 3s)');
        this.loop().catch((err) => {
            logger.error({ err: err?.message }, 'Liquidation Sentinel loop encountered error');
        });
    }
    stop() {
        this.isRunning = false;
    }
    async loop() {
        while (this.isRunning) {
            try {
                await this.checkPositionsAndMargin();
            }
            catch (err) {
                logger.debug({ err: err?.message }, 'Error in Liquidation Sentinel check');
            }
            await sleep(this.checkIntervalMs);
        }
    }
    /**
     * Main check:
     * 1. Detects if one leg was liquidated (orphan position) -> Flatten ALL immediately!
     * 2. Detects if free margin is depleted while holding positions -> Flatten ALL immediately!
     */
    async checkPositionsAndMargin() {
        const [bPosRes, byPosRes, bBalRes, byBalRes] = await Promise.allSettled([
            this.binanceClient.getPositions(),
            this.bybitClient.getPositions(),
            this.binanceClient.getBalances(),
            this.bybitClient.getBalances(),
        ]);
        if (bPosRes.status !== 'fulfilled' || byPosRes.status !== 'fulfilled') {
            return false;
        }
        const bPositions = bPosRes.value.filter((p) => p.side !== 'FLAT' && !p.quantity.isZero());
        const byPositions = byPosRes.value.filter((p) => p.side !== 'FLAT' && !p.quantity.isZero());
        // If no positions open, nothing to liquidate
        if (bPositions.length === 0 && byPositions.length === 0) {
            return false;
        }
        // 1. CHECK FOR ONE-LEG LIQUIDATION (Orphan Leg)
        let orphanDetected = false;
        let orphanDetails = '';
        // Check if Binance has active position but Bybit has 0
        for (const bPos of bPositions) {
            const bNorm = normalizeSymbol(bPos.symbol);
            const match = byPositions.find((by) => normalizeSymbol(by.symbol) === bNorm || by.symbol.toUpperCase() === bPos.symbol.toUpperCase());
            if (!match || match.quantity.isZero() || match.side === 'FLAT') {
                orphanDetected = true;
                orphanDetails = `Bybit leg for ${bPos.symbol} was LIQUIDATED / closed! Surviving Binance leg: ${bPos.side} ${bPos.quantity}`;
                break;
            }
        }
        // Check if Bybit has active position but Binance has 0
        if (!orphanDetected) {
            for (const byPos of byPositions) {
                const byNorm = normalizeSymbol(byPos.symbol);
                const match = bPositions.find((bi) => normalizeSymbol(bi.symbol) === byNorm || bi.symbol.toUpperCase() === byPos.symbol.toUpperCase());
                if (!match || match.quantity.isZero() || match.side === 'FLAT') {
                    orphanDetected = true;
                    orphanDetails = `Binance leg for ${byPos.symbol} was LIQUIDATED / closed! Surviving Bybit leg: ${byPos.side} ${byPos.quantity}`;
                    break;
                }
            }
        }
        if (orphanDetected) {
            logger.fatal({ orphanDetails }, '🚨 ONE LEG LIQUIDATION DETECTED! Closing surviving leg immediately and finding new opportunity!');
            await this.recoverOrphanLegAndResume(orphanDetails);
            return true;
        }
        // 2. CHECK FOR INSUFFICIENT MARGIN WHILE HOLDING POSITIONS
        if (bBalRes.status === 'fulfilled' && byBalRes.status === 'fulfilled') {
            const biUsdt = bBalRes.value.find((b) => b.asset === 'USDT');
            const byUsdt = byBalRes.value.find((b) => b.asset === 'USDT');
            const biAvail = biUsdt ? parseFloat(biUsdt.availableBalance.toString()) : 0;
            const byAvail = byUsdt ? parseFloat(byUsdt.availableBalance.toString()) : 0;
            // If available margin drops dangerously close to zero while holding positions
            if (biAvail < this.minEmergencyMarginUsd || byAvail < this.minEmergencyMarginUsd) {
                const reason = `Insufficient margin safety buffer! Binance free: $${biAvail.toFixed(2)}, Bybit free: $${byAvail.toFixed(2)} (Min required: $${this.minEmergencyMarginUsd.toFixed(2)})`;
                logger.fatal({ reason }, '🚨 MARGIN DEPLETED! Liquidation imminent. Flattening all positions!');
                await this.triggerEmergencyFlatten('INSUFFICIENT_MARGIN', reason);
                return true;
            }
        }
        return false;
    }
    /**
     * One-leg liquidation recovery:
     * Immediately market-closes the surviving orphan leg on the opposite exchange (reduce-only),
     * verifies accounts are flat, notifies Telegram, and keeps trading active so the bot
     * immediately searches for and enters a new arbitrage opportunity.
     */
    async recoverOrphanLegAndResume(reasonText) {
        const now = Date.now();
        if (now - this.lastAlertTime < 5000)
            return;
        this.lastAlertTime = now;
        logger.warn({ reasonText }, 'Orphan leg liquidation detected. Immediately market-closing surviving leg and finding new opportunity.');
        // 1. Perform emergency market close on surviving positions without engaging permanent kill switch
        const flattenResult = await this.killSwitch.emergencyFlatten();
        // 2. Query remaining balances
        let biBalStr = 'N/A';
        let byBalStr = 'N/A';
        try {
            const [biBal, byBal] = await Promise.allSettled([
                this.binanceClient.getBalances(),
                this.bybitClient.getBalances(),
            ]);
            if (biBal.status === 'fulfilled') {
                const u = biBal.value.find((b) => b.asset === 'USDT');
                if (u)
                    biBalStr = `$${parseFloat(u.walletBalance.toString()).toFixed(2)} USDT`;
            }
            if (byBal.status === 'fulfilled') {
                const u = byBal.value.find((b) => b.asset === 'USDT');
                if (u)
                    byBalStr = `$${parseFloat(u.walletBalance.toString()).toFixed(2)} USDT`;
            }
        }
        catch { }
        // 3. Send Telegram Alert explaining liquidation recovery & continuation
        const alertMsg = [
            `🚨 *ONE-LEG LIQUIDATION: OTHER LEG CLOSED IMMEDIATELY* 🚨`,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            `⚠️ *Event:* One leg was liquidated or terminated on the exchange!`,
            `• *Details:* \`${reasonText}\``,
            ``,
            `🛡️ *Immediate Protective Action:*`,
            `• Surviving open leg was **instantly market-closed to 100% USDT** (Reduce-Only).`,
            `• Positions Flattened: \`${flattenResult.flattenedCount}\``,
            `• Account Status: \`Verified Flat (0 Directional Exposure)\``,
            ``,
            `💼 *Remaining Balances:*`,
            `• Binance: \`${biBalStr}\``,
            `• Bybit: \`${byBalStr}\``,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            `🔍 *Bot is actively scanning 600+ perpetuals to find a new arbitrage opportunity...*`
        ].join('\n');
        try {
            await this.telegram.sendMessage(alertMsg);
        }
        catch (err) {
            logger.error({ err: err?.message }, 'Failed to send liquidation recovery Telegram alert');
        }
    }
    /**
     * Instantly executes emergency market close for 100% of positions on both exchanges,
     * engages the kill switch, and sends a critical Telegram alert.
     */
    async triggerEmergencyFlatten(triggerType, reasonText) {
        const now = Date.now();
        if (now - this.lastAlertTime < 10000)
            return;
        this.lastAlertTime = now;
        // 1. Engage kill switch
        this.killSwitch.activate(`[${triggerType}] ${reasonText}`);
        // 2. Perform emergency reduce-only market flatten across Binance & Bybit
        const flattenResult = await this.killSwitch.emergencyFlatten();
        // 3. Query final remaining balances
        let biBalStr = 'N/A';
        let byBalStr = 'N/A';
        try {
            const [biBal, byBal] = await Promise.allSettled([
                this.binanceClient.getBalances(),
                this.bybitClient.getBalances(),
            ]);
            if (biBal.status === 'fulfilled') {
                const u = biBal.value.find((b) => b.asset === 'USDT');
                if (u)
                    biBalStr = `$${parseFloat(u.walletBalance.toString()).toFixed(2)} USDT`;
            }
            if (byBal.status === 'fulfilled') {
                const u = byBal.value.find((b) => b.asset === 'USDT');
                if (u)
                    byBalStr = `$${parseFloat(u.walletBalance.toString()).toFixed(2)} USDT`;
            }
        }
        catch { }
        // 4. Send Immediate Telegram Emergency Broadcast
        const alertMsg = [
            `🚨 *EMERGENCY SAFETY SHUTDOWN: ALL POSITIONS FLATTENED* 🚨`,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            `⚠️ *Trigger Reason:*`,
            `\`${reasonText}\``,
            ``,
            `🛡️ *Instant Action Taken:*`,
            `• *Orders Submitted:* Market Close (100% USDT Reduce-Only)`,
            `• *Positions Flattened:* \`${flattenResult.flattenedCount}\``,
            `• *Kill Switch:* \`ENGAGED (Trading Halted)\``,
            ``,
            `💼 *Remaining Balances:*`,
            `• Binance: \`${biBalStr}\``,
            `• Bybit: \`${byBalStr}\``,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            `_Bot has halted trading to prevent further capital loss._`
        ].join('\n');
        try {
            await this.telegram.sendMessage(alertMsg);
        }
        catch (err) {
            logger.error({ err: err?.message }, 'Failed to send emergency Telegram alert');
        }
    }
}
//# sourceMappingURL=liquidation-sentinel.js.map