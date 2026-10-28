import { TradeDirection, TradeState } from '../persistence/models.js';
import { Decimal } from '../utils/decimal.js';
import { EvaluatedOpportunity } from '../strategy/opportunity-filter.js';

export interface ActiveTradeContext {
  tradeId: string;
  coin: string;
  binanceSymbol: string;
  bybitSymbol: string;
  fundingEventId: string;
  direction: TradeDirection;
  targetNotionalUsd: Decimal;
  binanceEntryQty: Decimal;
  bybitEntryQty: Decimal;
  state: TradeState;
  evaluatedOpp: EvaluatedOpportunity;
  isSimulated: boolean;
}

export interface ReconciliationResult {
  binanceExecutedQty: Decimal;
  bybitExecutedQty: Decimal;
  binanceAvgPrice: Decimal;
  bybitAvgPrice: Decimal;
  binanceNotionalUsd: Decimal;
  bybitNotionalUsd: Decimal;
  residualMismatchPct: Decimal;
  bothLegsFilled: boolean;
  oneLegFailed: boolean;
  isFlat: boolean;
  errors: string[];
}
