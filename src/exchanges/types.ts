import { Decimal } from '../utils/decimal.js';
import { ExchangeName, OrderSide, OrderType } from '../persistence/models.js';

export type { ExchangeName };

export interface InstrumentInfo {
  exchange: ExchangeName;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  settleAsset: string;
  contractType: 'PERPETUAL';
  contractMultiplier: Decimal;
  minQuantity: Decimal;
  quantityStep: Decimal;
  priceTick: Decimal;
  minNotional: Decimal;
  isActive: boolean;
  maxLeverage: number;
}

export interface FundingRateInfo {
  exchange: ExchangeName;
  symbol: string;
  fundingRate: Decimal; // e.g. 0.0001 = 0.01%
  fundingTimeMs: number;
  fundingIntervalHours?: number; // e.g. 8 for 8-hour, 4, 2, 1
  markPrice: Decimal;
  predictedRate?: Decimal;
  interestRate?: Decimal;
}

export interface OrderBookLevel {
  price: Decimal;
  quantity: Decimal;
}

export interface OrderBook {
  exchange: ExchangeName;
  symbol: string;
  bids: OrderBookLevel[]; // sorted descending by price
  asks: OrderBookLevel[]; // sorted ascending by price
  timestampMs: number;
}

export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  orderType: OrderType; // Strictly MARKET
  quantity: Decimal;
  clientOrderId: string;
  reduceOnly?: boolean;
}

export type OrderExecutionStatus = 'FILLED' | 'PARTIALLY_FILLED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED' | 'PENDING';

export interface OrderResult {
  exchange: ExchangeName;
  clientOrderId: string;
  exchangeOrderId: string | null;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  status: OrderExecutionStatus;
  requestedQuantity: Decimal;
  executedQuantity: Decimal;
  averagePrice: Decimal;
  fee: Decimal;
  feeCurrency: string;
  isReduceOnly: boolean;
  errorMessage?: string;
  timestampMs: number;
}

export interface Position {
  exchange: ExchangeName;
  symbol: string;
  side: 'LONG' | 'SHORT' | 'FLAT';
  quantity: Decimal;
  entryPrice: Decimal;
  markPrice: Decimal;
  unrealizedPnl: Decimal;
  leverage: number;
  updatedAtMs: number;
}

export interface AccountBalance {
  exchange: ExchangeName;
  asset: string;
  walletBalance: Decimal;
  availableBalance: Decimal;
  marginBalance: Decimal;
  unrealizedPnl: Decimal;
}

export interface CommissionRates {
  exchange: ExchangeName;
  symbol: string;
  makerRate: Decimal;
  takerRate: Decimal; // Authoritative rate for market orders
}

export interface FundingTransaction {
  exchange: ExchangeName;
  symbol: string;
  fundingRate: Decimal;
  positionNotional: Decimal;
  paymentAmount: Decimal; // Positive = received, Negative = paid
  asset: string;
  timestampMs: number;
}
