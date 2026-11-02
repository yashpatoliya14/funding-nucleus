import { request } from 'undici';
import { signBinance } from './authentication.js';
import { RateLimiter } from './rate-limiter.js';
import { toDecimal } from '../utils/decimal.js';
import { ExchangeApiError, InsufficientMarginError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { initializeDns } from '../utils/dns-resolver.js';
export class BinanceClient {
    exchangeName = 'binance';
    baseUrl;
    apiKey;
    apiSecret;
    rateLimiter;
    timeOffsetMs = 0;
    hasSyncedTime = false;
    isDualSidePosition = null; // Hedge Mode vs One-Way Mode
    fundingIntervalCache = new Map();
    lastFundingIntervalFetchMs = 0;
    INTERVAL_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
    constructor(options) {
        initializeDns();
        this.apiKey = options.apiKey;
        this.apiSecret = options.apiSecret;
        this.baseUrl = options.testnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
        // 2400 weight per minute limit, token bucket conservatively throttled
        this.rateLimiter = new RateLimiter({ maxRequests: 1200, intervalMs: 60000 });
    }
    async syncTime() {
        try {
            const t0 = Date.now();
            const serverTime = await this.getServerTime();
            const t1 = Date.now();
            const latency = Math.floor((t1 - t0) / 2);
            this.timeOffsetMs = serverTime - (t0 + latency);
            this.hasSyncedTime = true;
            return this.timeOffsetMs;
        }
        catch {
            return 0;
        }
    }
    async requestApi(method, endpoint, params = {}, authenticated = false) {
        return this.rateLimiter.executeWithRetry(async () => {
            let query = new URLSearchParams();
            for (const [k, v] of Object.entries(params)) {
                if (v !== undefined && v !== null) {
                    query.append(k, v.toString());
                }
            }
            const headers = {
                Accept: 'application/json',
            };
            if (authenticated) {
                if (!this.apiKey || !this.apiSecret) {
                    throw new ExchangeApiError(this.exchangeName, 'API key and secret required for authenticated endpoint');
                }
                if (!this.hasSyncedTime && endpoint !== '/fapi/v1/time') {
                    await this.syncTime();
                }
                headers['X-MBX-APIKEY'] = this.apiKey;
                const timestamp = Date.now() + this.timeOffsetMs;
                query.append('timestamp', timestamp.toString());
                query.append('recvWindow', '10000');
                const signature = signBinance(query.toString(), this.apiSecret);
                query.append('signature', signature);
            }
            let url = `${this.baseUrl}${endpoint}`;
            let body = undefined;
            if (method === 'GET' || method === 'DELETE') {
                const qs = query.toString();
                if (qs)
                    url += `?${qs}`;
            }
            else if (method === 'POST') {
                headers['Content-Type'] = 'application/x-www-form-urlencoded';
                body = query.toString();
            }
            const res = await request(url, {
                method,
                headers,
                body,
            });
            const responseText = await res.body.text();
            let data;
            try {
                data = JSON.parse(responseText);
            }
            catch {
                throw new ExchangeApiError(this.exchangeName, `Invalid JSON response: ${responseText}`, res.statusCode);
            }
            if (res.statusCode >= 400 || (data && typeof data === 'object' && 'code' in data && data.code < 0)) {
                const code = data?.code;
                const msg = data?.msg || responseText;
                if (code === -2019) {
                    throw new InsufficientMarginError(this.exchangeName, msg, data);
                }
                throw new ExchangeApiError(this.exchangeName, msg, res.statusCode, code, data);
            }
            return data;
        });
    }
    async getServerTime() {
        const data = await this.requestApi('GET', '/fapi/v1/time');
        return data.serverTime;
    }
    async getInstruments() {
        const data = await this.requestApi('GET', '/fapi/v1/exchangeInfo');
        const instruments = [];
        for (const s of data.symbols) {
            const isPerp = s.contractType === 'PERPETUAL' ||
                s.contractType === 'TRADIFI_PERPETUAL' ||
                (typeof s.contractType === 'string' && s.contractType.includes('PERPETUAL'));
            if (!isPerp || s.quoteAsset !== 'USDT')
                continue;
            let minQty = toDecimal('0.001');
            let qtyStep = toDecimal('0.001');
            let priceTick = toDecimal('0.01');
            let minNotional = toDecimal('5');
            for (const f of s.filters || []) {
                if (f.filterType === 'LOT_SIZE') {
                    minQty = toDecimal(f.minQty);
                    qtyStep = toDecimal(f.stepSize);
                }
                else if (f.filterType === 'PRICE_FILTER') {
                    priceTick = toDecimal(f.tickSize);
                }
                else if (f.filterType === 'MIN_NOTIONAL') {
                    minNotional = toDecimal(f.notional || '5');
                }
            }
            instruments.push({
                exchange: this.exchangeName,
                symbol: s.symbol,
                baseAsset: s.baseAsset,
                quoteAsset: s.quoteAsset,
                settleAsset: s.marginAsset,
                contractType: 'PERPETUAL',
                contractMultiplier: toDecimal('1'),
                minQuantity: minQty,
                quantityStep: qtyStep,
                priceTick,
                minNotional,
                isActive: s.status === 'TRADING',
                maxLeverage: 50,
            });
        }
        return instruments;
    }
    async getFundingRates() {
        const now = Date.now();
        let fetchFundingInfoPromise = Promise.resolve();
        if (now - this.lastFundingIntervalFetchMs > this.INTERVAL_CACHE_TTL_MS || this.fundingIntervalCache.size === 0) {
            fetchFundingInfoPromise = this.requestApi('GET', '/fapi/v1/fundingInfo')
                .then((fList) => {
                if (Array.isArray(fList)) {
                    for (const f of fList) {
                        if (f.symbol && typeof f.fundingIntervalHours === 'number') {
                            this.fundingIntervalCache.set(f.symbol, f.fundingIntervalHours);
                        }
                    }
                    this.lastFundingIntervalFetchMs = Date.now();
                }
            })
                .catch((err) => {
                logger.warn({ err: err?.message }, 'Failed to query Binance /fapi/v1/fundingInfo, falling back to cached intervals');
            });
        }
        const [list] = await Promise.all([
            this.requestApi('GET', '/fapi/v1/premiumIndex'),
            fetchFundingInfoPromise,
        ]);
        return list.map((item) => ({
            exchange: this.exchangeName,
            symbol: item.symbol,
            fundingRate: toDecimal(item.lastFundingRate || '0'),
            fundingTimeMs: Number(item.nextFundingTime),
            fundingIntervalHours: this.fundingIntervalCache.get(item.symbol) ?? (item.fundingIntervalHours ? Number(item.fundingIntervalHours) : 8),
            markPrice: toDecimal(item.markPrice || '0'),
            interestRate: toDecimal(item.interestRate || '0'),
        }));
    }
    async getOrderBook(symbol, limit = 20) {
        const data = await this.requestApi('GET', '/fapi/v1/depth', { symbol, limit });
        return {
            exchange: this.exchangeName,
            symbol,
            bids: (data.bids || []).map((b) => ({
                price: toDecimal(b[0]),
                quantity: toDecimal(b[1]),
            })),
            asks: (data.asks || []).map((a) => ({
                price: toDecimal(a[0]),
                quantity: toDecimal(a[1]),
            })),
            timestampMs: Date.now(),
        };
    }
    async getBalances() {
        const list = await this.requestApi('GET', '/fapi/v2/balance', {}, true);
        return list.map((item) => ({
            exchange: this.exchangeName,
            asset: item.asset,
            walletBalance: toDecimal(item.balance || '0'),
            availableBalance: toDecimal(item.availableBalance || '0'),
            marginBalance: toDecimal(item.accountAlias ? item.balance : item.crossWalletBalance || item.balance || '0'),
            unrealizedPnl: toDecimal(item.crossUnPnl || '0'),
        }));
    }
    async getPositions(symbol) {
        const params = {};
        if (symbol)
            params['symbol'] = symbol;
        const list = await this.requestApi('GET', '/fapi/v2/positionRisk', params, true);
        return list.map((p) => {
            const amt = toDecimal(p.positionAmt || '0');
            let side = 'FLAT';
            if (amt.isPositive() && !amt.isZero())
                side = 'LONG';
            else if (amt.isNegative())
                side = 'SHORT';
            return {
                exchange: this.exchangeName,
                symbol: p.symbol,
                side,
                quantity: amt.abs(),
                entryPrice: toDecimal(p.entryPrice || '0'),
                markPrice: toDecimal(p.markPrice || '0'),
                unrealizedPnl: toDecimal(p.unRealizedProfit || '0'),
                leverage: Number(p.leverage || 1),
                updatedAtMs: Number(p.updateTime || Date.now()),
            };
        });
    }
    async getCommissionRates(symbol) {
        const data = await this.requestApi('GET', '/fapi/v1/commissionRate', { symbol }, true);
        return {
            exchange: this.exchangeName,
            symbol,
            makerRate: toDecimal(data.makerCommissionRate || '0.0002'),
            takerRate: toDecimal(data.takerCommissionRate || '0.0005'),
        };
    }
    async syncPositionSideMode() {
        if (this.isDualSidePosition !== null)
            return this.isDualSidePosition;
        try {
            const res = await this.requestApi('GET', '/fapi/v1/positionSide/dual', {}, true);
            this.isDualSidePosition = Boolean(res.dualSidePosition);
        }
        catch {
            this.isDualSidePosition = false; // default One-Way mode
        }
        return this.isDualSidePosition;
    }
    async placeMarketOrder(order) {
        if (order.orderType !== 'MARKET') {
            throw new Error(`Enforcement violation: Order type must be MARKET, received: ${order.orderType}`);
        }
        const isHedgeMode = await this.syncPositionSideMode();
        const params = {
            symbol: order.symbol,
            side: order.side,
            type: 'MARKET',
            quantity: order.quantity.toString(),
            newClientOrderId: order.clientOrderId,
        };
        if (isHedgeMode) {
            // In Hedge Mode (dualSidePosition: true):
            // - Opening LONG or Closing LONG -> positionSide: 'LONG'
            // - Opening SHORT or Closing SHORT -> positionSide: 'SHORT'
            if (order.reduceOnly) {
                // Closing an existing position: BUY closes SHORT, SELL closes LONG
                params['positionSide'] = order.side === 'BUY' ? 'SHORT' : 'LONG';
            }
            else {
                // Opening a new position: BUY opens LONG, SELL opens SHORT
                params['positionSide'] = order.side === 'BUY' ? 'LONG' : 'SHORT';
            }
        }
        else {
            // In One-Way Mode (dualSidePosition: false):
            params['positionSide'] = 'BOTH';
            if (order.reduceOnly) {
                params['reduceOnly'] = 'true';
            }
        }
        try {
            const res = await this.requestApi('POST', '/fapi/v1/order', params, true);
            const executedQty = toDecimal(res.executedQty || '0');
            const cumQuote = toDecimal(res.cumQuote || '0');
            const avgPrice = executedQty.isPositive() && !executedQty.isZero() ? cumQuote.dividedBy(executedQty) : toDecimal(res.avgPrice || '0');
            let status = res.status;
            if (status === 'NEW')
                status = 'PENDING';
            return {
                exchange: this.exchangeName,
                clientOrderId: order.clientOrderId,
                exchangeOrderId: res.orderId ? res.orderId.toString() : null,
                symbol: order.symbol,
                side: order.side,
                orderType: 'MARKET',
                status,
                requestedQuantity: order.quantity,
                executedQuantity: executedQty,
                averagePrice: avgPrice,
                fee: toDecimal('0'), // Taker fee calculated in fill reconciliation
                feeCurrency: 'USDT',
                isReduceOnly: Boolean(order.reduceOnly),
                timestampMs: Number(res.updateTime || Date.now()),
            };
        }
        catch (err) {
            logger.error({ err, order }, 'Binance market order placement failed');
            throw err;
        }
    }
    async getOrderStatus(symbol, clientOrderId, exchangeOrderId) {
        const params = { symbol };
        if (exchangeOrderId)
            params['orderId'] = exchangeOrderId;
        else
            params['origClientOrderId'] = clientOrderId;
        const res = await this.requestApi('GET', '/fapi/v1/order', params, true);
        const executedQty = toDecimal(res.executedQty || '0');
        const cumQuote = toDecimal(res.cumQuote || '0');
        const avgPrice = executedQty.isPositive() && !executedQty.isZero() ? cumQuote.dividedBy(executedQty) : toDecimal(res.avgPrice || '0');
        let status = res.status;
        if (status === 'NEW')
            status = 'PENDING';
        return {
            exchange: this.exchangeName,
            clientOrderId,
            exchangeOrderId: res.orderId ? res.orderId.toString() : null,
            symbol,
            side: res.side,
            orderType: 'MARKET',
            status,
            requestedQuantity: toDecimal(res.origQty || '0'),
            executedQuantity: executedQty,
            averagePrice: avgPrice,
            fee: toDecimal('0'),
            feeCurrency: 'USDT',
            isReduceOnly: Boolean(res.reduceOnly),
            timestampMs: Number(res.updateTime || Date.now()),
        };
    }
    async getFundingHistory(symbol, startTime, limit = 50) {
        const params = { symbol, incomeType: 'FUNDING_FEE', limit };
        if (startTime)
            params['startTime'] = startTime;
        const list = await this.requestApi('GET', '/fapi/v1/income', params, true);
        return list.map((item) => ({
            exchange: this.exchangeName,
            symbol: item.symbol,
            fundingRate: toDecimal('0'), // Binance income records payment directly
            positionNotional: toDecimal('0'),
            paymentAmount: toDecimal(item.income || '0'),
            asset: item.asset,
            timestampMs: Number(item.time),
        }));
    }
    async getMaxLeverage(symbol) {
        try {
            const res = await this.requestApi('GET', '/fapi/v1/leverageBracket', { symbol }, true);
            const brackets = Array.isArray(res) && res[0]?.brackets ? res[0].brackets : [];
            if (brackets.length > 0) {
                let max = 0;
                for (const b of brackets) {
                    const lev = Number(b.initialLeverage);
                    if (lev > max)
                        max = lev;
                }
                if (max > 0)
                    return max;
            }
        }
        catch {
            // Fallback if leverageBracket requires specific symbol or permissions
        }
        return 20; // Safe default for Binance perpetuals
    }
    async setLeverage(symbol, leverage) {
        await this.requestApi('POST', '/fapi/v1/leverage', { symbol, leverage }, true);
        return true;
    }
}
//# sourceMappingURL=binance.client.js.map