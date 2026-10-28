import fs from 'node:fs';
import path from 'node:path';
import DatabaseConstructor, { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { logger } from '../utils/logger.js';

export class AppDatabase {
  private db: BetterSqliteDatabase | null = null;
  private readonly dbPath: string;

  constructor(dbPath: string = './data/funding-bot.sqlite') {
    this.dbPath = path.resolve(process.cwd(), dbPath);
  }

  public connect(): BetterSqliteDatabase {
    if (this.db) return this.db;

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      this.db = new DatabaseConstructor(this.dbPath, {
        verbose: process.env['DEBUG_SQL'] ? (sql) => logger.debug({ sql }, 'SQLite Query') : undefined,
      });

      // Durability, concurrency, and integrity pragmas
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('synchronous = NORMAL');

      logger.info({ dbPath: this.dbPath }, 'Connected to SQLite database with WAL mode');
      return this.db;
    } catch (error) {
      logger.error({ error, dbPath: this.dbPath }, 'Failed to initialize SQLite database');
      throw error;
    }
  }

  public getDb(): BetterSqliteDatabase {
    if (!this.db) {
      return this.connect();
    }
    return this.db;
  }

  public close(): void {
    if (this.db) {
      try {
        this.db.pragma('wal_checkpoint(TRUNCATE)');
        this.db.close();
        this.db = null;
        logger.info('SQLite database connection closed successfully');
      } catch (error) {
        logger.error({ error }, 'Error while closing SQLite database');
      }
    }
  }

  public transaction<T>(fn: () => T): T {
    const db = this.getDb();
    return db.transaction(fn)();
  }
}
