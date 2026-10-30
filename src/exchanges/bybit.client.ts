import { request } from 'undici';
import { IExchangeClient } from './exchange.interface.js';
import {
  AccountBalance,
  CommissionRates,
  FundingRateInfo,
  FundingTransaction,
  InstrumentInfo,
  OrderBook,
  OrderExecutionStatus,
  OrderRequest,
  OrderResult,
  Position,
} from './types.js';
import { signBybit } from './authentication.js';
import { RateLimiter } from './rate-limiter.js';
import { Decimal, toDecimal } from '../utils/decimal.js';
import { ExchangeApiError, InsufficientMarginError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { initializeDns } from '../utils/dns-resolver.js';

export interface BybitClientOptions {
  apiKey: string;
  apiSecret: string;
  testnet?: boolean;
}

export class BybitClient implements IExchangeClient {
  public readonly exchangeName = 'bybit' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly rateLimiter: RateLimiter;
  private timeOffsetMs: number = 0;
  private hasSyncedTime: boolean = false;

  constructor(options: BybitClientOptions) {
    initializeDns();
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.baseUrl = options.testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    // 50 requests per second limit, token bucket throttled
    this.rateLimiter = new RateLimiter({ maxRequests: 50, intervalMs: 1000 });
  }

  async syncTime(): Promise<number> {
    try {
      const t0 = Date.now();
      const serverTime = await this.getServerTime();
      const t1 = Date.now();
      const latency = Math.floor((t1 - t0) / 2);
      this.timeOffsetMs = serverTime - (t0 + latency);
      this.hasSyncedTime = true;
      return this.timeOffsetMs;
    } catch {
      return 0;
    }
  }

  private async requestApi<T>(
    method: 'GET' | 'POST',
    endpoint: string,
    params: Record<string, any> = {},
    authenticated: boolean = false
  ): Promise<T> {
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
      } else if (method === 'POST') {
        bodyString = JSON.stringify(params);
      }

      let headers: Record<string, string> = {
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
      if (qs) url += `?${qs}`;

      const res = await request(url, {
        method,
        headers,
        body: method === 'POST' ? bodyString : undefined,
      });

      const responseText = await res.body.text();
      let data: any;
      try {
        data = JSON.parse(responseText);
      } catch {
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

      return data.result as T;
    });
  }

  async getServerTime(): Promise<number> {
    const data = await this.requestApi<{ timeNano: string; timeSecond: string }>('GET', '/v5/market/time');
    return Number(data.timeSecond) * 1000;
  }

  async getInstruments(): Promise<InstrumentInfo[]> {
    const data = await this.requestApi<{ list: any[] }>('GET', '/v5/market/instruments-info', {
      category: 'linear',
      status: 'Trading',
    });

    const instruments: InstrumentInfo[] = [];

    for (const s of data.list || []) {
      if (s.quoteCoin !== 'USDT' || s.contractType !== 'LinearPerpetual') continue;

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

  async getFundingRates(): Promise<FundingRateInfo[]> {
    const data = await this.requestApi<{ list: any[] }>('GET', '/v5/market/tickers', {
      category: 'linear',
    });

    return (data.list || []).map((t) => ({
      exchange: this.exchangeName,
      symbol: t.symbol,
      fundingRate: toDecimal(t.fundingRate || '0'),
      fundingTimeMs: Number(t.nextFundingTime),
      markPrice: toDecimal(t.markPrice || '0'),
      predictedRate: t.predictedDeliveryPrice ? toDecimal(t.predictedDeliveryPrice) : undefined,
    }));
  }

  async getOrderBook(symbol: string, limit: number = 25): Promise<OrderBook> {
    const data = await this.requestApi<any>('GET', '/v5/market/orderbook', {
      category: 'linear',
      symbol,
      limit,
    });

    return {
      exchange: this.exchangeName,
      symbol,
      bids: (data.b || []).map((b: string[]) => ({
        price: toDecimal(b[0]!),
        quantity: toDecimal(b[1]!),
      })),
      asks: (data.a || []).map((a: string[]) => ({
        price: toDecimal(a[0]!),
        quantity: toDecimal(a[1]!),
      })),
      timestampMs: Number(data.ts || Date.now()),
    };
  }

  async getBalances(): Promise<AccountBalance[]> {
    const data = await this.requestApi<{ list: any[] }>('GET', '/v5/account/wallet-balance', {
      accountType: 'UNIFIED',
    }, true);

    const balances: AccountBalance[] = [];
    for (const item of data.list || []) {
      for (const coin of item.coin || []) {
        balances.push({
          exchange: this.exchangeName,
          asset: coin.coin,
          walletBalance: toDecimal(coin.walletBalance || '0'),
          availableBalance: toDecimal(coin.availableToWithdraw || coin.walletBalance || '0'),
          marginBalance: toDecimal(coin.equity || coin.walletBalance || '0'),
          unrealizedPnl: toDecimal(coin.unrealisedPnl || '0'),
        });
      }
    }

    return balances;
  }

  async getPositions(symbol?: string): Promise<Position[]> {
    const params: Record<string, any> = { category: 'linear', settleCoin: 'USDT' };
    if (symbol) params['symbol'] = symbol;

    const data = await this.requestApi<{ list: any[] }>('GET', '/v5/position/list', params, true);

    return (data.list || []).map((p) => {
      const size = toDecimal(p.size || '0');
      let side: 'LONG' | 'SHORT' | 'FLAT' = 'FLAT';
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

  async getCommissionRates(symbol: string): Promise<CommissionRates> {
    const data = await this.requestApi<{ list: any[] }>('GET', '/v5/account/fee-rate', {
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

  async placeMarketOrder(order: OrderRequest): Promise<OrderResult> {
    if (order.orderType !== 'MARKET') {
      throw new Error(`Enforcement violation: Order type must be MARKET, received: ${order.orderType}`);
    }

    const side = order.side === 'BUY' ? 'Buy' : 'Sell';
    const params: Record<string, any> = {
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
      const res = await this.requestApi<{ orderId: string; orderLinkId: string }>('POST', '/v5/order/create', params, true);

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
    } catch (err: any) {
      logger.error({ err, order }, 'Bybit market order placement failed');
      throw err;
    }
  }

  async getOrderStatus(symbol: string, clientOrderId: string, exchangeOrderId?: string): Promise<OrderResult> {
    const params: Record<string, any> = { category: 'linear', symbol };
    if (exchangeOrderId) params['orderId'] = exchangeOrderId;
    else params['orderLinkId'] = clientOrderId;

    const data = await this.requestApi<{ list: any[] }>('GET', '/v5/order/realtime', params, true);
    const orderData = data.list?.[0];

    if (!orderData) {
      // Check historical orders if already finished
      const historyData = await this.requestApi<{ list: any[] }>('GET', '/v5/order/history', params, true);
      const histOrder = historyData.list?.[0];
      if (!histOrder) {
        throw new ExchangeApiError(this.exchangeName, `Order ${clientOrderId} not found on Bybit`);
      }
      return this.mapBybitOrder(histOrder, clientOrderId);
    }

    return this.mapBybitOrder(orderData, clientOrderId);
  }

  private mapBybitOrder(o: any, clientOrderId: string): OrderResult {
    let status: OrderExecutionStatus = 'PENDING';
    if (o.orderStatus === 'Filled') status = 'FILLED';
    else if (o.orderStatus === 'PartiallyFilled') status = 'PARTIALLY_FILLED';
    else if (o.orderStatus === 'Cancelled') status = 'CANCELLED';
    else if (o.orderStatus === 'Rejected') status = 'REJECTED';

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

  async getFundingHistory(symbol: string, startTime?: number, limit: number = 50): Promise<FundingTransaction[]> {
    const params: Record<string, any> = { category: 'linear', symbol, execType: 'Funding', limit };
    if (startTime) params['startTime'] = startTime;

    const data = await this.requestApi<{ list: any[] }>('GET', '/v5/execution/list', params, true);
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

  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    try {
      await this.requestApi<any>('POST', '/v5/position/set-leverage', {
        category: 'linear',
        symbol,
        buyLeverage: leverage.toString(),
        sellLeverage: leverage.toString(),
      }, true);
      return true;
    } catch (err: any) {
      if (err?.message?.includes('leverage not modified') || err?.errorCode === 110043) {
        return true;
      }
      throw err;
    }
  }
}
