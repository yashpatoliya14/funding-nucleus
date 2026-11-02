import { TradeState } from '../persistence/models.js';
import { StateTransitionRepository, TradeRepository } from '../persistence/repositories.js';
export declare class TradeStateMachine {
    private tradeRepo;
    private transitionRepo;
    constructor(tradeRepo: TradeRepository, transitionRepo: StateTransitionRepository);
    canTransition(from: TradeState, to: TradeState): boolean;
    transition(tradeId: string, currentState: TradeState, nextState: TradeState, reason: string, metadata?: Record<string, any>): TradeState;
}
//# sourceMappingURL=state-machine.d.ts.map