import { request } from 'undici';
import { IExchangeClient } from './exchange.interface.js';
import {
  AccountBalance,
  CommissionRates,
  FundingRateInfo,
  FundingTransaction,
  InstrumentInfo,
  OrderBook,
  OrderRequest,
  OrderResult,
  Position,
} from './types.js';
import { signBinance } from './authentication.js';
import { RateLimiter } from './rate-limiter.js';
import { Decimal, toDecimal } from '../utils/decimal.js';
import { ExchangeApiError, InsufficientMarginError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { initializeDns } from '../utils/dns-resolver.js';

export interface BinanceClientOptions {
  apiKey: string;
  apiSecret: string;
  testnet?: boolean;
}

export class BinanceClient implements IExchangeClient {
  public readonly exchangeName = 'binance' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly rateLimiter: RateLimiter;
  private timeOffsetMs: number = 0;
  private hasSyncedTime: boolean = false;

  constructor(options: BinanceClientOptions) {
    initializeDns();
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.baseUrl = options.testnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
    // 2400 weight per minute limit, token bucket conservatively throttled
    this.rateLimiter = new RateLimiter({ maxRequests: 1200, intervalMs: 60000 });
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
    method: 'GET' | 'POST' | 'DELETE',
    endpoint: string,
    params: Record<string, any> = {},
    authenticated: boolean = false
  ): Promise<T> {
    return this.rateLimiter.executeWithRetry(async () => {
      let query = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) {
          query.append(k, v.toString());
        }
      }

      const headers: Record<string, string> = {
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
      let body: string | undefined = undefined;

      if (method === 'GET' || method === 'DELETE') {
        const qs = query.toString();
        if (qs) url += `?${qs}`;
      } else if (method === 'POST') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = query.toString();
      }

      const res = await request(url, {
        method,
        headers,
        body,
      });

      const responseText = await res.body.text();
      let data: any;
      try {
        data = JSON.parse(responseText);
      } catch {
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

      return data as T;
    });
  }

  async getServerTime(): Promise<number> {
    const data = await this.requestApi<{ serverTime: number }>('GET', '/fapi/v1/time');
    return data.serverTime;
  }

  async getInstruments(): Promise<InstrumentInfo[]> {
    const data = await this.requestApi<{ symbols: any[] }>('GET', '/fapi/v1/exchangeInfo');
    const instruments: InstrumentInfo[] = [];

    for (const s of data.symbols) {
      if (s.contractType !== 'PERPETUAL' || s.quoteAsset !== 'USDT') continue;

      let minQty = toDecimal('0.001');
      let qtyStep = toDecimal('0.001');
      let priceTick = toDecimal('0.01');
      let minNotional = toDecimal('5');

      for (const f of s.filters || []) {
        if (f.filterType === 'LOT_SIZE') {
          minQty = toDecimal(f.minQty);
          qtyStep = toDecimal(f.stepSize);
        } else if (f.filterType === 'PRICE_FILTER') {
          priceTick = toDecimal(f.tickSize);
        } else if (f.filterType === 'MIN_NOTIONAL') {
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

  async getFundingRates(): Promise<FundingRateInfo[]> {
    const list = await this.requestApi<any[]>('GET', '/fapi/v1/premiumIndex');
    return list.map((item) => ({
      exchange: this.exchangeName,
      symbol: item.symbol,
      fundingRate: toDecimal(item.lastFundingRate || '0'),
      fundingTimeMs: Number(item.nextFundingTime),
      markPrice: toDecimal(item.markPrice || '0'),
      interestRate: toDecimal(item.interestRate || '0'),
    }));
  }

  async getOrderBook(symbol: string, limit: number = 20): Promise<OrderBook> {
    const data = await this.requestApi<any>('GET', '/fapi/v1/depth', { symbol, limit });
    return {
      exchange: this.exchangeName,
      symbol,
      bids: (data.bids || []).map((b: string[]) => ({
        price: toDecimal(b[0]!),
        quantity: toDecimal(b[1]!),
      })),
      asks: (data.asks || []).map((a: string[]) => ({
        price: toDecimal(a[0]!),
        quantity: toDecimal(a[1]!),
      })),
      timestampMs: Date.now(),
    };
  }

  async getBalances(): Promise<AccountBalance[]> {
    const list = await this.requestApi<any[]>('GET', '/fapi/v2/balance', {}, true);
    return list.map((item) => ({
      exchange: this.exchangeName,
      asset: item.asset,
      walletBalance: toDecimal(item.balance || '0'),
      availableBalance: toDecimal(item.availableBalance || '0'),
      marginBalance: toDecimal(item.accountAlias ? item.balance : item.crossWalletBalance || item.balance || '0'),
      unrealizedPnl: toDecimal(item.crossUnPnl || '0'),
    }));
  }

  async getPositions(symbol?: string): Promise<Position[]> {
    const params: Record<string, any> = {};
    if (symbol) params['symbol'] = symbol;
    const list = await this.requestApi<any[]>('GET', '/fapi/v2/positionRisk', params, true);

    return list.map((p) => {
      const amt = toDecimal(p.positionAmt || '0');
      let side: 'LONG' | 'SHORT' | 'FLAT' = 'FLAT';
      if (amt.isPositive() && !amt.isZero()) side = 'LONG';
      else if (amt.isNegative()) side = 'SHORT';

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

  async getCommissionRates(symbol: string): Promise<CommissionRates> {
    const data = await this.requestApi<any>('GET', '/fapi/v1/commissionRate', { symbol }, true);
    return {
      exchange: this.exchangeName,
      symbol,
      makerRate: toDecimal(data.makerCommissionRate || '0.0002'),
      takerRate: toDecimal(data.takerCommissionRate || '0.0005'),
    };
  }

  async placeMarketOrder(order: OrderRequest): Promise<OrderResult> {
    if (order.orderType !== 'MARKET') {
      throw new Error(`Enforcement violation: Order type must be MARKET, received: ${order.orderType}`);
    }

    const params: Record<string, any> = {
      symbol: order.symbol,
      side: order.side,
      type: 'MARKET',
      quantity: order.quantity.toString(),
      newClientOrderId: order.clientOrderId,
    };

    if (order.reduceOnly) {
      params['reduceOnly'] = 'true';
    }

    try {
      const res = await this.requestApi<any>('POST', '/fapi/v1/order', params, true);
      const executedQty = toDecimal(res.executedQty || '0');
      const cumQuote = toDecimal(res.cumQuote || '0');
      const avgPrice = executedQty.isPositive() && !executedQty.isZero() ? cumQuote.dividedBy(executedQty) : toDecimal(res.avgPrice || '0');

      let status: any = res.status;
      if (status === 'NEW') status = 'PENDING';

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
    } catch (err: any) {
      logger.error({ err, order }, 'Binance market order placement failed');
      throw err;
    }
  }

  async getOrderStatus(symbol: string, clientOrderId: string, exchangeOrderId?: string): Promise<OrderResult> {
    const params: Record<string, any> = { symbol };
    if (exchangeOrderId) params['orderId'] = exchangeOrderId;
    else params['origClientOrderId'] = clientOrderId;

    const res = await this.requestApi<any>('GET', '/fapi/v1/order', params, true);
    const executedQty = toDecimal(res.executedQty || '0');
    const cumQuote = toDecimal(res.cumQuote || '0');
    const avgPrice = executedQty.isPositive() && !executedQty.isZero() ? cumQuote.dividedBy(executedQty) : toDecimal(res.avgPrice || '0');

    let status: any = res.status;
    if (status === 'NEW') status = 'PENDING';

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

  async getFundingHistory(symbol: string, startTime?: number, limit: number = 50): Promise<FundingTransaction[]> {
    const params: Record<string, any> = { symbol, incomeType: 'FUNDING_FEE', limit };
    if (startTime) params['startTime'] = startTime;

    const list = await this.requestApi<any[]>('GET', '/fapi/v1/income', params, true);
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

  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    await this.requestApi<any>('POST', '/fapi/v1/leverage', { symbol, leverage }, true);
    return true;
  }
}
