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
import { ExchangeName } from '../persistence/models.js';
import { Decimal, toDecimal } from '../utils/decimal.js';
import { logger } from '../utils/logger.js';

export interface PaperClientOptions {
  exchangeName: ExchangeName;
  initialBalanceUsdt?: Decimal | number | string;
  takerFeeRate?: Decimal | number | string;
  makerFeeRate?: Decimal | number | string;
  simulateFailure?: 'NONE' | 'REJECT' | 'PARTIAL' | 'TIMEOUT';
}

export class PaperClient implements IExchangeClient {
  public readonly exchangeName: ExchangeName;
  private balances: Map<string, Decimal> = new Map();
  private positions: Map<string, Position> = new Map();
  private orders: Map<string, OrderResult> = new Map();
  private fundingHistory: FundingTransaction[] = [];
  private books: Map<string, OrderBook> = new Map();
  private rates: Map<string, FundingRateInfo> = new Map();
  private instruments: Map<string, InstrumentInfo> = new Map();
  private takerFeeRate: Decimal;
  private makerFeeRate: Decimal;
  private failureMode: 'NONE' | 'REJECT' | 'PARTIAL' | 'TIMEOUT';

  constructor(options: PaperClientOptions) {
    this.exchangeName = options.exchangeName;
    const initialBal = toDecimal(options.initialBalanceUsdt ?? '10000');
    this.balances.set('USDT', initialBal);
    this.takerFeeRate = toDecimal(options.takerFeeRate ?? (this.exchangeName === 'binance' ? '0.0005' : '0.00055'));
    this.makerFeeRate = toDecimal(options.makerFeeRate ?? '0.0002');
    this.failureMode = options.simulateFailure ?? 'NONE';
  }

  public setFailureMode(mode: 'NONE' | 'REJECT' | 'PARTIAL' | 'TIMEOUT') {
    this.failureMode = mode;
  }

  public mockOrderBook(book: OrderBook) {
    this.books.set(book.symbol, book);
  }

  public mockFundingRate(rate: FundingRateInfo) {
    this.rates.set(rate.symbol, rate);
  }

  public mockInstrument(inst: InstrumentInfo) {
    this.instruments.set(inst.symbol, inst);
  }

  async getServerTime(): Promise<number> {
    return Date.now();
  }

  async getInstruments(): Promise<InstrumentInfo[]> {
    if (this.instruments.size > 0) {
      return Array.from(this.instruments.values());
    }
    // Default simulated instruments
    return [
      {
        exchange: this.exchangeName,
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        settleAsset: 'USDT',
        contractType: 'PERPETUAL',
        contractMultiplier: toDecimal('1'),
        minQuantity: toDecimal('0.001'),
        quantityStep: toDecimal('0.001'),
        priceTick: toDecimal('0.1'),
        minNotional: toDecimal('5'),
        isActive: true,
        maxLeverage: 50,
      },
      {
        exchange: this.exchangeName,
        symbol: 'ETHUSDT',
        baseAsset: 'ETH',
        quoteAsset: 'USDT',
        settleAsset: 'USDT',
        contractType: 'PERPETUAL',
        contractMultiplier: toDecimal('1'),
        minQuantity: toDecimal('0.01'),
        quantityStep: toDecimal('0.01'),
        priceTick: toDecimal('0.01'),
        minNotional: toDecimal('5'),
        isActive: true,
        maxLeverage: 50,
      },
    ];
  }

  async getFundingRates(): Promise<FundingRateInfo[]> {
    if (this.rates.size > 0) {
      return Array.from(this.rates.values());
    }
    // Default simulated rates (next 8h funding)
    const nextFunding = Math.ceil(Date.now() / (8 * 3600 * 1000)) * (8 * 3600 * 1000);
    return [
      {
        exchange: this.exchangeName,
        symbol: 'BTCUSDT',
        fundingRate: this.exchangeName === 'binance' ? toDecimal('0.0003') : toDecimal('0.0001'),
        fundingTimeMs: nextFunding,
        markPrice: toDecimal('65000'),
      },
      {
        exchange: this.exchangeName,
        symbol: 'ETHUSDT',
        fundingRate: this.exchangeName === 'binance' ? toDecimal('0.0001') : toDecimal('0.0004'),
        fundingTimeMs: nextFunding,
        markPrice: toDecimal('3500'),
      },
    ];
  }

  async getOrderBook(symbol: string, _limit?: number): Promise<OrderBook> {
    const existing = this.books.get(symbol);
    if (existing) return existing;

    // Generate realistic order book around reference price
    const basePrice = symbol.startsWith('BTC') ? 65000 : 3500;
    const bids = [
      { price: toDecimal(basePrice - 0.5), quantity: toDecimal('5.0') },
      { price: toDecimal(basePrice - 1.0), quantity: toDecimal('10.0') },
      { price: toDecimal(basePrice - 2.0), quantity: toDecimal('20.0') },
    ];
    const asks = [
      { price: toDecimal(basePrice + 0.5), quantity: toDecimal('5.0') },
      { price: toDecimal(basePrice + 1.0), quantity: toDecimal('10.0') },
      { price: toDecimal(basePrice + 2.0), quantity: toDecimal('20.0') },
    ];

    const book: OrderBook = {
      exchange: this.exchangeName,
      symbol,
      bids,
      asks,
      timestampMs: Date.now(),
    };
    this.books.set(symbol, book);
    return book;
  }

  async getBalances(): Promise<AccountBalance[]> {
    const bal = this.balances.get('USDT') ?? toDecimal('10000');
    return [
      {
        exchange: this.exchangeName,
        asset: 'USDT',
        walletBalance: bal,
        availableBalance: bal,
        marginBalance: bal,
        unrealizedPnl: toDecimal('0'),
      },
    ];
  }

  async getPositions(symbol?: string): Promise<Position[]> {
    if (symbol) {
      const p = this.positions.get(symbol);
      return p ? [p] : [];
    }
    return Array.from(this.positions.values()).filter((p) => !p.quantity.isZero());
  }

  async getCommissionRates(symbol: string): Promise<CommissionRates> {
    return {
      exchange: this.exchangeName,
      symbol,
      makerRate: this.makerFeeRate,
      takerRate: this.takerFeeRate,
    };
  }

  async placeMarketOrder(order: OrderRequest): Promise<OrderResult> {
    if (order.orderType !== 'MARKET') {
      throw new Error(`Enforcement violation: Order type must be MARKET, received: ${order.orderType}`);
    }

    if (this.failureMode === 'REJECT') {
      const rejectedResult: OrderResult = {
        exchange: this.exchangeName,
        clientOrderId: order.clientOrderId,
        exchangeOrderId: `sim-rej-${Date.now()}`,
        symbol: order.symbol,
        side: order.side,
        orderType: 'MARKET',
        status: 'REJECTED',
        requestedQuantity: order.quantity,
        executedQuantity: toDecimal('0'),
        averagePrice: toDecimal('0'),
        fee: toDecimal('0'),
        feeCurrency: 'USDT',
        isReduceOnly: Boolean(order.reduceOnly),
        errorMessage: 'Simulated market order rejection',
        timestampMs: Date.now(),
      };
      this.orders.set(order.clientOrderId, rejectedResult);
      return rejectedResult;
    }

    if (this.failureMode === 'TIMEOUT') {
      throw new Error(`[${this.exchangeName.toUpperCase()}] Simulated network timeout placing order`);
    }

    const book = await this.getOrderBook(order.symbol);
    const levels = order.side === 'BUY' ? book.asks : book.bids;

    let remainingQty = this.failureMode === 'PARTIAL' ? order.quantity.times('0.5') : order.quantity;
    let totalCost = toDecimal('0');
    let filledQty = toDecimal('0');

    for (const level of levels) {
      if (remainingQty.isZero()) break;
      const takeQty = Decimal.min(remainingQty, level.quantity);
      totalCost = totalCost.plus(takeQty.times(level.price));
      filledQty = filledQty.plus(takeQty);
      remainingQty = remainingQty.minus(takeQty);
    }

    const avgPrice = filledQty.isPositive() ? totalCost.dividedBy(filledQty) : levels[0]!.price;
    const fee = totalCost.times(this.takerFeeRate);

    // Update simulated wallet balance
    const currentBal = this.balances.get('USDT') ?? toDecimal('10000');
    this.balances.set('USDT', currentBal.minus(fee));

    // Update position
    const existingPos = this.positions.get(order.symbol) || {
      exchange: this.exchangeName,
      symbol: order.symbol,
      side: 'FLAT',
      quantity: toDecimal('0'),
      entryPrice: avgPrice,
      markPrice: avgPrice,
      unrealizedPnl: toDecimal('0'),
      leverage: 5,
      updatedAtMs: Date.now(),
    };

    if (order.reduceOnly) {
      // Reduce position
      const newQty = Decimal.max(toDecimal('0'), existingPos.quantity.minus(filledQty));
      existingPos.quantity = newQty;
      if (newQty.isZero()) {
        existingPos.side = 'FLAT';
      }
    } else {
      // Add or change position
      if (existingPos.side === 'FLAT' || (existingPos.side === 'LONG' && order.side === 'BUY') || (existingPos.side === 'SHORT' && order.side === 'SELL')) {
        const newQty = existingPos.quantity.plus(filledQty);
        existingPos.side = order.side === 'BUY' ? 'LONG' : 'SHORT';
        existingPos.quantity = newQty;
        existingPos.entryPrice = avgPrice;
      } else {
        // Flipping or partially closing
        const diff = existingPos.quantity.minus(filledQty);
        if (diff.isPositive()) {
          existingPos.quantity = diff;
        } else {
          existingPos.quantity = diff.abs();
          existingPos.side = order.side === 'BUY' ? 'LONG' : 'SHORT';
          existingPos.entryPrice = avgPrice;
        }
      }
    }
    existingPos.updatedAtMs = Date.now();
    this.positions.set(order.symbol, existingPos);

    const status: OrderExecutionStatus = this.failureMode === 'PARTIAL' ? 'PARTIALLY_FILLED' : 'FILLED';
    const result: OrderResult = {
      exchange: this.exchangeName,
      clientOrderId: order.clientOrderId,
      exchangeOrderId: `sim-ord-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      symbol: order.symbol,
      side: order.side,
      orderType: 'MARKET',
      status,
      requestedQuantity: order.quantity,
      executedQuantity: filledQty,
      averagePrice: avgPrice,
      fee,
      feeCurrency: 'USDT',
      isReduceOnly: Boolean(order.reduceOnly),
      timestampMs: Date.now(),
    };

    this.orders.set(order.clientOrderId, result);
    logger.info({ exchange: this.exchangeName, order: result }, 'Simulated paper market order executed');
    return result;
  }

  async getOrderStatus(_symbol: string, clientOrderId: string, _exchangeOrderId?: string): Promise<OrderResult> {
    const ord = this.orders.get(clientOrderId);
    if (!ord) {
      throw new Error(`[${this.exchangeName}] Order not found: ${clientOrderId}`);
    }
    return ord;
  }

  async getFundingHistory(symbol: string, _startTime?: number, _limit?: number): Promise<FundingTransaction[]> {
    return this.fundingHistory.filter((f) => f.symbol === symbol);
  }

  public recordSimulatedFunding(tx: FundingTransaction) {
    this.fundingHistory.push(tx);
    const bal = this.balances.get('USDT') ?? toDecimal('10000');
    this.balances.set('USDT', bal.plus(tx.paymentAmount));
  }
}
