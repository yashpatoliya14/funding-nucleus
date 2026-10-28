import { SymbolRepository } from '../persistence/repositories.js';
import { SymbolMatcher } from './symbol-matcher.js';
import { DbSymbolMapping } from '../persistence/models.js';
import { logger } from '../utils/logger.js';

export class SymbolCache {
  constructor(
    private symbolRepo: SymbolRepository,
    private matcher: SymbolMatcher,
    private ttlHours: number = 24
  ) {}

  async refreshIfExpired(): Promise<DbSymbolMapping[]> {
    const existing = this.symbolRepo.getAllActive();
    const now = new Date();

    const isExpired = existing.length === 0 || existing.some((s) => new Date(s.expires_at) <= now);

    if (isExpired) {
      logger.info('Symbol cache expired or empty. Refreshing matched pairs from exchanges...');
      const pairs = await this.matcher.matchInstruments();
      for (const p of pairs) {
        const dbMapping = SymbolMatcher.toDbMapping(p, this.ttlHours);
        this.symbolRepo.upsert(dbMapping);
      }
      return this.symbolRepo.getAllActive();
    }

    logger.debug({ cachedSymbols: existing.length }, 'Symbol cache is fresh, skipping refresh');
    return existing;
  }

  getMapping(normalizedSymbol: string): DbSymbolMapping | undefined {
    return this.symbolRepo.getByNormalized(normalizedSymbol.toUpperCase());
  }

  getAllActive(): DbSymbolMapping[] {
    return this.symbolRepo.getAllActive();
  }
}
