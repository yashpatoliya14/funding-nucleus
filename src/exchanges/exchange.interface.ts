import {
  ExchangeName,
  InstrumentInfo,
  FundingRateInfo,
  OrderBook,
  AccountBalance,
  Position,
  CommissionRates,
  OrderRequest,
  OrderResult,
  FundingTransaction,
} from './types.js';

export interface IExchangeClient {
  readonly exchangeName: ExchangeName;

  /**
   * Retrieves active perpetual instruments and trading specifications.
   */
  getInstruments(): Promise<InstrumentInfo[]>;

  /**
   * Retrieves current funding rates, mark prices, and next funding timestamps.
   */
  getFundingRates(): Promise<FundingRateInfo[]>;

  /**
   * Retrieves current L2 order book depth.
   */
  getOrderBook(symbol: string, limit?: number): Promise<OrderBook>;

  /**
   * Retrieves account balances and available margin.
   */
  getBalances(): Promise<AccountBalance[]>;

  /**
   * Retrieves current open positions.
   */
  getPositions(symbol?: string): Promise<Position[]>;

  /**
   * Retrieves account-specific commission rates (maker and taker).
   */
  getCommissionRates(symbol: string): Promise<CommissionRates>;

  /**
   * Retrieves server time in milliseconds for clock drift detection.
   */
  getServerTime(): Promise<number>;

  /**
   * Places a market order (strict MARKET order only).
   */
  placeMarketOrder(order: OrderRequest): Promise<OrderResult>;

  /**
   * Reconciles order execution status by client order ID or exchange order ID.
   */
  getOrderStatus(symbol: string, clientOrderId: string, exchangeOrderId?: string): Promise<OrderResult>;

  /**
   * Retrieves actual funding payment/receipt history.
   */
  getFundingHistory(symbol: string, startTime?: number, limit?: number): Promise<FundingTransaction[]>;

  /**
   * Sets leverage for a given symbol.
   */
  setLeverage?(symbol: string, leverage: number): Promise<boolean>;
}
