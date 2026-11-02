import { request } from 'undici';
import { signBybit } from './authentication.js';
import { RateLimiter } from './rate-limiter.js';
import { toDecimal } from '../utils/decimal.js';
import { ExchangeApiError, InsufficientMarginError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { initializeDns } from '../utils/dns-resolver.js';
export class BybitClient {
    exchangeName = 'bybit';
    baseUrl;
    apiKey;
    apiSecret;
    rateLimiter;
    timeOffsetMs = 0;
    hasSyncedTime = false;
    constructor(options) {
        initializeDns();
        this.apiKey = options.apiKey;
        this.apiSecret = options.apiSecret;
        this.baseUrl = options.testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
        // 50 requests per second limit, token bucket throttled
        this.rateLimiter = new RateLimiter({ maxRequests: 50, intervalMs: 1000 });
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
            let bodyString = '';
            if (authenticated && !this.hasSyncedTime && endpoint !== '/v5/market/time') {
                await this.syncTime();
            }
            const timestamp = Date.now() + this.timeOffsetMs;
            if (method === 'GET') {
                for (const [k, v] of Object.entries(params)) {
                    if (v !== undefined && v !== null) {
                        query.append(k, v.toString());
                    }
                }
            }
            else if (method === 'POST') {
                bodyString = JSON.stringify(params);
            }
            let headers = {
                Accept: 'application/json',
            };
            if (authenticated) {
                if (!this.apiKey || !this.apiSecret) {
                    throw new ExchangeApiError(this.exchangeName, 'API key and secret required for authenticated endpoint');
                }
                const signPayload = method === 'GET' ? query.toString() : bodyString;
                const authHeaders = signBybit(this.apiKey, this.apiSecret, timestamp, signPayload, 10000);
                headers = { ...headers, ...authHeaders };
            }
            let url = `${this.baseUrl}${endpoint}`;
            const qs = query.toString();
            if (qs)
                url += `?${qs}`;
            const res = await request(url, {
                method,
                headers,
                body: method === 'POST' ? bodyString : undefined,
            });
            const responseText = await res.body.text();
            let data;
            try {
                data = JSON.parse(responseText);
            }
            catch {
                throw new ExchangeApiError(this.exchangeName, `Invalid JSON response: ${responseText}`, res.statusCode);
            }
            if (res.statusCode >= 400 || data.retCode !== 0) {
                const retCode = data.retCode;
                const retMsg = data.retMsg || responseText;
                if (retCode === 110007 || retCode === 170131 || retMsg.includes('insufficient balance')) {
                    throw new InsufficientMarginError(this.exchangeName, retMsg, data);
                }
                throw new ExchangeApiError(this.exchangeName, retMsg, res.statusCode, retCode, data);
            }
            return data.result;
        });
    }
    async getServerTime() {
        const data = await this.requestApi('GET', '/v5/market/time');
        return Number(data.timeSecond) * 1000;
    }
    async getInstruments() {
        const rawList = [];
        let cursor = undefined;
        do {
            const params = {
                category: 'linear',
                status: 'Trading',
                limit: 1000,
            };
            if (cursor) {
                params.cursor = cursor;
            }
            const data = await this.requestApi('GET', '/v5/market/instruments-info', params);
            if (data && Array.isArray(data.list)) {
                rawList.push(...data.list);
            }
            cursor = data && data.nextPageCursor && data.nextPageCursor.trim() !== '' ? data.nextPageCursor : undefined;
        } while (cursor);
        const instruments = [];
        for (const s of rawList) {
            if (s.quoteCoin !== 'USDT' || s.contractType !== 'LinearPerpetual')
                continue;
            const lotFilter = s.lotSizeFilter || {};
            const priceFilter = s.priceFilter || {};
            instruments.push({
                exchange: this.exchangeName,
                symbol: s.symbol,
                baseAsset: s.baseCoin,
                quoteAsset: s.quoteCoin,
                settleAsset: s.settleCoin,
                contractType: 'PERPETUAL',
                contractMultiplier: toDecimal('1'),
                minQuantity: toDecimal(lotFilter.minOrderQty || '0.001'),
                quantityStep: toDecimal(lotFilter.qtyStep || '0.001'),
                priceTick: toDecimal(priceFilter.tickSize || '0.01'),
                minNotional: toDecimal(lotFilter.minNotionalValue || '5'),
                isActive: s.status === 'Trading',
                maxLeverage: Number(s.leverageFilter?.maxLeverage || 50),
            });
        }
        return instruments;
    }
    async getFundingRates() {
        const data = await this.requestApi('GET', '/v5/market/tickers', {
            category: 'linear',
        });
        return (data.list || []).map((t) => ({
            exchange: this.exchangeName,
            symbol: t.symbol,
            fundingRate: toDecimal(t.fundingRate || '0'),
            fundingTimeMs: Number(t.nextFundingTime),
            fundingIntervalHours: t.fundingIntervalHour ? Number(t.fundingIntervalHour) : 8,
            markPrice: toDecimal(t.markPrice || '0'),
            predictedRate: t.predictedDeliveryPrice ? toDecimal(t.predictedDeliveryPrice) : undefined,
        }));
    }
    async getOrderBook(symbol, limit = 25) {
        const data = await this.requestApi('GET', '/v5/market/orderbook', {
            category: 'linear',
            symbol,
            limit,
        });
        return {
            exchange: this.exchangeName,
            symbol,
            bids: (data.b || []).map((b) => ({
                price: toDecimal(b[0]),
                quantity: toDecimal(b[1]),
            })),
            asks: (data.a || []).map((a) => ({
                price: toDecimal(a[0]),
                quantity: toDecimal(a[1]),
            })),
            timestampMs: Number(data.ts || Date.now()),
        };
    }
    async getBalances() {
        const data = await this.requestApi('GET', '/v5/account/wallet-balance', {
            accountType: 'UNIFIED',
        }, true);
        const balances = [];
        for (const item of data.list || []) {
            const itemAvail = item.totalAvailableBalance && item.totalAvailableBalance !== '' ? item.totalAvailableBalance : '0';
            const itemWallet = item.totalWalletBalance && item.totalWalletBalance !== '' ? item.totalWalletBalance : '0';
            const itemEquity = item.totalEquity && item.totalEquity !== '' ? item.totalEquity : itemWallet;
            for (const coin of item.coin || []) {
                const wBal = coin.walletBalance && coin.walletBalance !== '' ? coin.walletBalance : '0';
                const eq = coin.equity && coin.equity !== '' ? coin.equity : wBal;
                const rawAvail = coin.availableToWithdraw && coin.availableToWithdraw !== '' && coin.availableToWithdraw !== '0'
                    ? coin.availableToWithdraw
                    : (parseFloat(wBal) > 0 ? wBal : (parseFloat(eq) > 0 ? eq : itemAvail));
                balances.push({
                    exchange: this.exchangeName,
                    asset: coin.coin,
                    walletBalance: toDecimal(wBal),
                    availableBalance: toDecimal(rawAvail),
                    marginBalance: toDecimal(eq),
                    unrealizedPnl: toDecimal(coin.unrealisedPnl || '0'),
                });
            }
            // If USDT is not found or has 0 balance, but the Unified account has available balance in USD/equity:
            const usdtEntry = balances.find((b) => b.asset === 'USDT');
            if (!usdtEntry && parseFloat(itemWallet) > 0) {
                balances.push({
                    exchange: this.exchangeName,
                    asset: 'USDT',
                    walletBalance: toDecimal(itemWallet),
                    availableBalance: toDecimal(parseFloat(itemAvail) > 0 ? itemAvail : itemWallet),
                    marginBalance: toDecimal(itemEquity),
                    unrealizedPnl: toDecimal(item.totalPerpUPL || '0'),
                });
            }
            else if (usdtEntry && usdtEntry.availableBalance.isZero() && parseFloat(itemAvail) > 0) {
                usdtEntry.availableBalance = toDecimal(itemAvail);
                if (usdtEntry.walletBalance.isZero()) {
                    usdtEntry.walletBalance = toDecimal(itemWallet);
                }
            }
        }
        return balances;
    }
    async getPositions(symbol) {
        const params = { category: 'linear', settleCoin: 'USDT' };
        if (symbol)
            params['symbol'] = symbol;
        const data = await this.requestApi('GET', '/v5/position/list', params, true);
        return (data.list || []).map((p) => {
            const size = toDecimal(p.size || '0');
            let side = 'FLAT';
            if (size.isPositive() && !size.isZero()) {
                side = p.side === 'Buy' ? 'LONG' : 'SHORT';
            }
            return {
                exchange: this.exchangeName,
                symbol: p.symbol,
                side,
                quantity: size,
                entryPrice: toDecimal(p.avgPrice || '0'),
                markPrice: toDecimal(p.markPrice || '0'),
                unrealizedPnl: toDecimal(p.unrealisedPnl || '0'),
                leverage: Number(p.leverage || 1),
                updatedAtMs: Number(p.updatedTime || Date.now()),
            };
        });
    }
    async getCommissionRates(symbol) {
        const data = await this.requestApi('GET', '/v5/account/fee-rate', {
            category: 'linear',
            symbol,
        }, true);
        const feeInfo = data.list?.[0] || {};
        return {
            exchange: this.exchangeName,
            symbol,
            makerRate: toDecimal(feeInfo.makerFeeRate || '0.0002'),
            takerRate: toDecimal(feeInfo.takerFeeRate || '0.00055'),
        };
    }
    async placeMarketOrder(order) {
        if (order.orderType !== 'MARKET') {
            throw new Error(`Enforcement violation: Order type must be MARKET, received: ${order.orderType}`);
        }
        const side = order.side === 'BUY' ? 'Buy' : 'Sell';
        const params = {
            category: 'linear',
            symbol: order.symbol,
            side,
            orderType: 'Market',
            qty: order.quantity.toString(),
            orderLinkId: order.clientOrderId,
        };
        if (order.reduceOnly) {
            params['reduceOnly'] = true;
        }
        try {
            const res = await this.requestApi('POST', '/v5/order/create', params, true);
            // Bybit creates order, then we retrieve immediate execution state
            return {
                exchange: this.exchangeName,
                clientOrderId: order.clientOrderId,
                exchangeOrderId: res.orderId,
                symbol: order.symbol,
                side: order.side,
                orderType: 'MARKET',
                status: 'PENDING',
                requestedQuantity: order.quantity,
                executedQuantity: toDecimal('0'),
                averagePrice: toDecimal('0'),
                fee: toDecimal('0'),
                feeCurrency: 'USDT',
                isReduceOnly: Boolean(order.reduceOnly),
                timestampMs: Date.now(),
            };
        }
        catch (err) {
            logger.error({ err, order }, 'Bybit market order placement failed');
            throw err;
        }
    }
    async getOrderStatus(symbol, clientOrderId, exchangeOrderId) {
        const params = { category: 'linear', symbol };
        if (exchangeOrderId)
            params['orderId'] = exchangeOrderId;
        else
            params['orderLinkId'] = clientOrderId;
        const data = await this.requestApi('GET', '/v5/order/realtime', params, true);
        const orderData = data.list?.[0];
        if (!orderData) {
            // Check historical orders if already finished
            const historyData = await this.requestApi('GET', '/v5/order/history', params, true);
            const histOrder = historyData.list?.[0];
            if (!histOrder) {
                throw new ExchangeApiError(this.exchangeName, `Order ${clientOrderId} not found on Bybit`);
            }
            return this.mapBybitOrder(histOrder, clientOrderId);
        }
        return this.mapBybitOrder(orderData, clientOrderId);
    }
    mapBybitOrder(o, clientOrderId) {
        let status = 'PENDING';
        if (o.orderStatus === 'Filled')
            status = 'FILLED';
        else if (o.orderStatus === 'PartiallyFilled')
            status = 'PARTIALLY_FILLED';
        else if (o.orderStatus === 'Cancelled')
            status = 'CANCELLED';
        else if (o.orderStatus === 'Rejected')
            status = 'REJECTED';
        const side = o.side === 'Buy' ? 'BUY' : 'SELL';
        return {
            exchange: this.exchangeName,
            clientOrderId: o.orderLinkId || clientOrderId,
            exchangeOrderId: o.orderId,
            symbol: o.symbol,
            side,
            orderType: 'MARKET',
            status,
            requestedQuantity: toDecimal(o.qty || '0'),
            executedQuantity: toDecimal(o.cumExecQty || '0'),
            averagePrice: toDecimal(o.avgPrice || '0'),
            fee: toDecimal(o.cumExecFee || '0'),
            feeCurrency: 'USDT',
            isReduceOnly: Boolean(o.reduceOnly),
            timestampMs: Number(o.updatedTime || Date.now()),
        };
    }
    async getFundingHistory(symbol, startTime, limit = 50) {
        const params = { category: 'linear', symbol, execType: 'Funding', limit };
        if (startTime)
            params['startTime'] = startTime;
        const data = await this.requestApi('GET', '/v5/execution/list', params, true);
        return (data.list || []).map((item) => ({
            exchange: this.exchangeName,
            symbol: item.symbol,
            fundingRate: toDecimal(item.execFee || '0'),
            positionNotional: toDecimal(item.execValue || '0'),
            paymentAmount: toDecimal(item.execFee || '0').negated(), // Bybit execFee > 0 means fee deducted
            asset: 'USDT',
            timestampMs: Number(item.execTime),
        }));
    }
    async getMaxLeverage(symbol) {
        try {
            const data = await this.requestApi('GET', '/v5/market/instruments-info', {
                category: 'linear',
                symbol,
            });
            const item = data?.list?.[0];
            if (item?.leverageFilter?.maxLeverage) {
                return Number(item.leverageFilter.maxLeverage);
            }
        }
        catch {
            // Fallback
        }
        return 25;
    }
    async setLeverage(symbol, leverage) {
        try {
            await this.requestApi('POST', '/v5/position/set-leverage', {
                category: 'linear',
                symbol,
                buyLeverage: leverage.toString(),
                sellLeverage: leverage.toString(),
            }, true);
            return true;
        }
        catch (err) {
            if (err?.message?.includes('leverage not modified') || err?.errorCode === 110043) {
                return true;
            }
            throw err;
        }
    }
}
//# sourceMappingURL=bybit.client.js.map