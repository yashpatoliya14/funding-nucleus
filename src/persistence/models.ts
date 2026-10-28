export type ExchangeName = 'binance' | 'bybit';
export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET';
export type TradeDirection = 'SHORT_BINANCE_LONG_BYBIT' | 'LONG_BINANCE_SHORT_BYBIT';

export type TradeState =
  | 'IDLE'
  | 'SCANNING'
  | 'OPPORTUNITY_VALIDATED'
  | 'RISK_APPROVED'
  | 'EXECUTION_INTENT_SAVED'
  | 'ENTRY_SUBMITTED'
  | 'ENTRY_RECONCILIATION'
  | 'BOTH_LEGS_HEDGED'
  | 'WAITING_FOR_FUNDING'
  | 'FUNDING_RECONCILIATION'
  | 'EXIT_PENDING'
  | 'CLOSING_POSITIONS'
  | 'FLAT_VERIFICATION'
  | 'COMPLETED'
  | 'REJECTED'
  | 'FAILED'
  | 'RECOVERY_REQUIRED'
  | 'ABORT_AND_FLATTEN'
  | 'EMERGENCY';

export interface DbSymbolMapping {
  id: string;
  normalized_symbol: string; // e.g. "BTC"
  binance_symbol: string; // e.g. "BTCUSDT"
  bybit_symbol: string; // e.g. "BTCUSDT"
  base_asset: string;
  quote_asset: string;
  contract_multiplier: string;
  min_quantity: string;
  quantity_step: string;
  price_tick: string;
  binance_status: string;
  bybit_status: string;
  is_active: number; // 1 or 0
  last_validated_at: string; // ISO UTC
  expires_at: string; // ISO UTC
}

export interface DbTrade {
  id: string; // UUID
  coin: string;
  binance_symbol: string;
  bybit_symbol: string;
  funding_event_id: string;
  state: TradeState;
  direction: TradeDirection;
  target_notional_usd: string;
  binance_entry_qty: string;
  bybit_entry_qty: string;
  binance_exit_qty: string;
  bybit_exit_qty: string;
  expected_funding_edge_pct: string;
  expected_net_profit_usd: string;
  realized_pnl_usd: string;
  total_fees_usd: string;
  total_funding_usd: string;
  net_pnl_usd: string;
  is_simulated: number; // 1 or 0
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface DbOrder {
  id: string; // internal UUID
  trade_id: string;
  exchange: ExchangeName;
  client_order_id: string;
  exchange_order_id: string | null;
  symbol: string;
  side: OrderSide;
  order_type: OrderType;
  requested_quantity: string;
  executed_quantity: string;
  average_price: string;
  status: 'PENDING' | 'FILLED' | 'PARTIALLY_FILLED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  is_reduce_only: number; // 1 or 0
  is_recovery: number; // 1 or 0
  purpose: 'ENTRY' | 'EXIT' | 'RECOVERY';
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbFill {
  id: string;
  order_id: string;
  trade_id: string;
  exchange: ExchangeName;
  exchange_execution_id: string | null;
  price: string;
  quantity: string;
  fee: string;
  fee_currency: string;
  timestamp: string;
}

export interface DbFundingEvent {
  id: string;
  coin: string;
  binance_funding_rate: string;
  bybit_funding_rate: string;
  funding_rate_diff: string;
  binance_funding_time: string;
  bybit_funding_time: string;
  target_funding_time: string;
  is_aligned: number;
  status: 'DETECTED' | 'EVALUATED' | 'TRADED' | 'SETTLED' | 'EXPIRED';
  created_at: string;
}

export interface DbFundingTransaction {
  id: string;
  trade_id: string;
  exchange: ExchangeName;
  symbol: string;
  funding_rate: string;
  position_notional: string;
  payment_amount: string; // positive = received, negative = paid
  asset: string;
  timestamp: string;
  is_simulated: number;
}

export interface DbPositionSnapshot {
  id: string;
  trade_id: string;
  exchange: ExchangeName;
  symbol: string;
  side: 'LONG' | 'SHORT' | 'FLAT';
  quantity: string;
  entry_price: string;
  mark_price: string;
  unrealized_pnl: string;
  leverage: string;
  timestamp: string;
}

export interface DbStateTransition {
  id: string;
  trade_id: string;
  from_state: string;
  to_state: string;
  reason: string;
  metadata: string | null; // JSON string
  timestamp: string;
}

export interface DbRiskEvent {
  id: string;
  event_type: 'LIMIT_VIOLATION' | 'CIRCUIT_BREAKER_TRIPPED' | 'KILL_SWITCH_ACTIVATED' | 'EMERGENCY_FLATTEN' | 'WARNING';
  rule_name: string;
  trade_id: string | null;
  details: string; // JSON string
  timestamp: string;
}

export interface DbDailySummary {
  date: string; // YYYY-MM-DD
  trade_count: number;
  total_trading_pnl_usd: string;
  total_funding_pnl_usd: string;
  total_fees_usd: string;
  net_pnl_usd: string;
  loss_limit_hit: number;
  created_at: string;
  updated_at: string;
}
