import { SymbolRepository } from '../persistence/repositories.js';
import { SymbolMatcher } from './symbol-matcher.js';
import { DbSymbolMapping } from '../persistence/models.js';
export declare class SymbolCache {
    private symbolRepo;
    private matcher;
    private ttlHours;
    constructor(symbolRepo: SymbolRepository, matcher: SymbolMatcher, ttlHours?: number);
    refreshIfExpired(): Promise<DbSymbolMapping[]>;
    getMapping(normalizedSymbol: string): DbSymbolMapping | undefined;
    getAllActive(): DbSymbolMapping[];
}
//# sourceMappingURL=symbol-cache.d.ts.map