import { TradeState } from '../persistence/models.js';
import { StateTransitionRepository, TradeRepository } from '../persistence/repositories.js';
import { StateMachineError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const VALID_TRANSITIONS: Record<TradeState, TradeState[]> = {
  IDLE: ['SCANNING'],
  SCANNING: ['OPPORTUNITY_VALIDATED', 'IDLE'],
  OPPORTUNITY_VALIDATED: ['RISK_APPROVED', 'REJECTED', 'IDLE'],
  RISK_APPROVED: ['EXECUTION_INTENT_SAVED', 'REJECTED'],
  EXECUTION_INTENT_SAVED: ['ENTRY_SUBMITTED', 'FAILED'],
  ENTRY_SUBMITTED: ['ENTRY_RECONCILIATION'],
  ENTRY_RECONCILIATION: ['BOTH_LEGS_HEDGED', 'RECOVERY_REQUIRED', 'ABORT_AND_FLATTEN'],
  RECOVERY_REQUIRED: ['BOTH_LEGS_HEDGED', 'ABORT_AND_FLATTEN', 'FAILED'],
  ABORT_AND_FLATTEN: ['FLAT_VERIFICATION', 'EMERGENCY', 'FAILED'],
  BOTH_LEGS_HEDGED: ['WAITING_FOR_FUNDING', 'EMERGENCY', 'ABORT_AND_FLATTEN'],
  WAITING_FOR_FUNDING: ['FUNDING_RECONCILIATION', 'EMERGENCY', 'ABORT_AND_FLATTEN'],
  FUNDING_RECONCILIATION: ['EXIT_PENDING', 'EMERGENCY'],
  EXIT_PENDING: ['CLOSING_POSITIONS', 'EMERGENCY'],
  CLOSING_POSITIONS: ['FLAT_VERIFICATION', 'EMERGENCY'],
  FLAT_VERIFICATION: ['COMPLETED', 'EMERGENCY', 'FAILED'],
  COMPLETED: [],
  REJECTED: [],
  FAILED: [],
  EMERGENCY: ['FLAT_VERIFICATION', 'FAILED'],
};

export class TradeStateMachine {
  constructor(
    private tradeRepo: TradeRepository,
    private transitionRepo: StateTransitionRepository
  ) {}

  public canTransition(from: TradeState, to: TradeState): boolean {
    if (from === to) return true; // Idempotent
    if (to === 'EMERGENCY') return true; // Emergency always permitted
    const allowed = VALID_TRANSITIONS[from];
    return Boolean(allowed && allowed.includes(to));
  }

  public transition(tradeId: string, currentState: TradeState, nextState: TradeState, reason: string, metadata?: Record<string, any>): TradeState {
    if (currentState === nextState) {
      logger.debug({ tradeId, state: currentState }, 'State transition is idempotent (same state)');
      return currentState;
    }

    if (!this.canTransition(currentState, nextState)) {
      const err = new StateMachineError(`Cannot transition from ${currentState} to ${nextState}`, currentState, nextState);
      logger.error({ tradeId, currentState, nextState, reason }, err.message);
      throw err;
    }

    const now = new Date().toISOString();

    // 1. Persist state transition history
    this.transitionRepo.record({
      id: `st-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      trade_id: tradeId,
      from_state: currentState,
      to_state: nextState,
      reason,
      metadata: metadata ? JSON.stringify(metadata) : null,
      timestamp: now,
    });

    // 2. Update trade state in SQLite
    this.tradeRepo.update({
      id: tradeId,
      state: nextState,
      completed_at: nextState === 'COMPLETED' ? now : undefined,
    });

    logger.info({ tradeId, from: currentState, to: nextState, reason }, 'Trade state transitioned');
    return nextState;
  }
}
