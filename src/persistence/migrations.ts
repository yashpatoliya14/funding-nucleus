import { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { AppDatabase } from './database.js';
import { logger } from '../utils/logger.js';
import { loadConfig } from '../config/env.js';

interface Migration {
  version: number;
  name: string;
  up: (db: BetterSqliteDatabase) => void;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: (db: BetterSqliteDatabase) => {
      // 1. Symbol mappings table
      db.exec(`
        CREATE TABLE IF NOT EXISTS symbol_mappings (
          id TEXT PRIMARY KEY,
          normalized_symbol TEXT NOT NULL,
          binance_symbol TEXT NOT NULL,
          bybit_symbol TEXT NOT NULL,
          base_asset TEXT NOT NULL,
          quote_asset TEXT NOT NULL,
          contract_multiplier TEXT NOT NULL,
          min_quantity TEXT NOT NULL,
          quantity_step TEXT NOT NULL,
          price_tick TEXT NOT NULL,
          binance_status TEXT NOT NULL,
          bybit_status TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1,
          last_validated_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_symbol_mappings_normalized ON symbol_mappings (normalized_symbol);
      `);

      // 2. Funding events table
      db.exec(`
        CREATE TABLE IF NOT EXISTS funding_events (
          id TEXT PRIMARY KEY,
          coin TEXT NOT NULL,
          binance_funding_rate TEXT NOT NULL,
          bybit_funding_rate TEXT NOT NULL,
          funding_rate_diff TEXT NOT NULL,
          binance_funding_time TEXT NOT NULL,
          bybit_funding_time TEXT NOT NULL,
          target_funding_time TEXT NOT NULL,
          is_aligned INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_funding_events_coin_time ON funding_events (coin, target_funding_time);
      `);

      // 3. Trades table
      db.exec(`
        CREATE TABLE IF NOT EXISTS trades (
          id TEXT PRIMARY KEY,
          coin TEXT NOT NULL,
          binance_symbol TEXT NOT NULL,
          bybit_symbol TEXT NOT NULL,
          funding_event_id TEXT NOT NULL,
          state TEXT NOT NULL,
          direction TEXT NOT NULL,
          target_notional_usd TEXT NOT NULL,
          binance_entry_qty TEXT NOT NULL DEFAULT '0',
          bybit_entry_qty TEXT NOT NULL DEFAULT '0',
          binance_exit_qty TEXT NOT NULL DEFAULT '0',
          bybit_exit_qty TEXT NOT NULL DEFAULT '0',
          expected_funding_edge_pct TEXT NOT NULL,
          expected_net_profit_usd TEXT NOT NULL,
          realized_pnl_usd TEXT NOT NULL DEFAULT '0',
          total_fees_usd TEXT NOT NULL DEFAULT '0',
          total_funding_usd TEXT NOT NULL DEFAULT '0',
          net_pnl_usd TEXT NOT NULL DEFAULT '0',
          is_simulated INTEGER NOT NULL DEFAULT 1,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          FOREIGN KEY (funding_event_id) REFERENCES funding_events(id)
        );
        CREATE INDEX IF NOT EXISTS idx_trades_state ON trades (state);
        CREATE INDEX IF NOT EXISTS idx_trades_coin ON trades (coin);
      `);

      // 4. Orders table (MARKET orders only)
      db.exec(`
        CREATE TABLE IF NOT EXISTS orders (
          id TEXT PRIMARY KEY,
          trade_id TEXT NOT NULL,
          exchange TEXT NOT NULL,
          client_order_id TEXT NOT NULL UNIQUE,
          exchange_order_id TEXT,
          symbol TEXT NOT NULL,
          side TEXT NOT NULL,
          order_type TEXT NOT NULL,
          requested_quantity TEXT NOT NULL,
          executed_quantity TEXT NOT NULL DEFAULT '0',
          average_price TEXT NOT NULL DEFAULT '0',
          status TEXT NOT NULL,
          is_reduce_only INTEGER NOT NULL DEFAULT 0,
          is_recovery INTEGER NOT NULL DEFAULT 0,
          purpose TEXT NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (trade_id) REFERENCES trades(id)
        );
        CREATE INDEX IF NOT EXISTS idx_orders_trade_id ON orders (trade_id);
        CREATE INDEX IF NOT EXISTS idx_orders_client_id ON orders (client_order_id);
      `);

      // 5. Fills table
      db.exec(`
        CREATE TABLE IF NOT EXISTS fills (
          id TEXT PRIMARY KEY,
          order_id TEXT NOT NULL,
          trade_id TEXT NOT NULL,
          exchange TEXT NOT NULL,
          exchange_execution_id TEXT,
          price TEXT NOT NULL,
          quantity TEXT NOT NULL,
          fee TEXT NOT NULL,
          fee_currency TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          FOREIGN KEY (order_id) REFERENCES orders(client_order_id),
          FOREIGN KEY (trade_id) REFERENCES trades(id)
        );
        CREATE INDEX IF NOT EXISTS idx_fills_order_id ON fills (order_id);
        CREATE INDEX IF NOT EXISTS idx_fills_trade_id ON fills (trade_id);
      `);

      // 6. Funding transactions table
      db.exec(`
        CREATE TABLE IF NOT EXISTS funding_transactions (
          id TEXT PRIMARY KEY,
          trade_id TEXT NOT NULL,
          exchange TEXT NOT NULL,
          symbol TEXT NOT NULL,
          funding_rate TEXT NOT NULL,
          position_notional TEXT NOT NULL,
          payment_amount TEXT NOT NULL,
          asset TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          is_simulated INTEGER NOT NULL DEFAULT 1,
          FOREIGN KEY (trade_id) REFERENCES trades(id)
        );
        CREATE INDEX IF NOT EXISTS idx_funding_transactions_trade_id ON funding_transactions (trade_id);
      `);

      // 7. Position snapshots table
      db.exec(`
        CREATE TABLE IF NOT EXISTS position_snapshots (
          id TEXT PRIMARY KEY,
          trade_id TEXT NOT NULL,
          exchange TEXT NOT NULL,
          symbol TEXT NOT NULL,
          side TEXT NOT NULL,
          quantity TEXT NOT NULL,
          entry_price TEXT NOT NULL,
          mark_price TEXT NOT NULL,
          unrealized_pnl TEXT NOT NULL,
          leverage TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          FOREIGN KEY (trade_id) REFERENCES trades(id)
        );
        CREATE INDEX IF NOT EXISTS idx_position_snapshots_trade_id ON position_snapshots (trade_id);
      `);

      // 8. State transitions table
      db.exec(`
        CREATE TABLE IF NOT EXISTS state_transitions (
          id TEXT PRIMARY KEY,
          trade_id TEXT NOT NULL,
          from_state TEXT NOT NULL,
          to_state TEXT NOT NULL,
          reason TEXT NOT NULL,
          metadata TEXT,
          timestamp TEXT NOT NULL,
          FOREIGN KEY (trade_id) REFERENCES trades(id)
        );
        CREATE INDEX IF NOT EXISTS idx_state_transitions_trade_id ON state_transitions (trade_id);
      `);

      // 9. Risk events table
      db.exec(`
        CREATE TABLE IF NOT EXISTS risk_events (
          id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          rule_name TEXT NOT NULL,
          trade_id TEXT,
          details TEXT NOT NULL,
          timestamp TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_risk_events_timestamp ON risk_events (timestamp);
      `);

      // 10. Daily summaries table
      db.exec(`
        CREATE TABLE IF NOT EXISTS daily_summaries (
          date TEXT PRIMARY KEY,
          trade_count INTEGER NOT NULL DEFAULT 0,
          total_trading_pnl_usd TEXT NOT NULL DEFAULT '0',
          total_funding_pnl_usd TEXT NOT NULL DEFAULT '0',
          total_fees_usd TEXT NOT NULL DEFAULT '0',
          net_pnl_usd TEXT NOT NULL DEFAULT '0',
          loss_limit_hit INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
];

export function runMigrations(db: BetterSqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedVersions = new Set<number>(
    db.prepare('SELECT version FROM schema_migrations').all().map((row: any) => row.version)
  );

  for (const migration of migrations) {
    if (!appliedVersions.has(migration.version)) {
      logger.info({ version: migration.version, name: migration.name }, 'Applying database migration');
      db.transaction(() => {
        migration.up(db);
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          migration.version,
          migration.name,
          new Date().toISOString()
        );
      })();
      logger.info({ version: migration.version, name: migration.name }, 'Applied database migration successfully');
    }
  }
}

// Standalone execution script
if (process.argv[1]?.endsWith('migrations.ts') || process.argv[1]?.endsWith('migrations.js')) {
  try {
    const config = loadConfig();
    const appDb = new AppDatabase(config.appConfig.persistence.path);
    const db = appDb.connect();
    runMigrations(db);
    appDb.close();
    console.log('Database migrations completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}
