import { toDecimal } from '../utils/decimal.js';
export class SymbolRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    upsert(mapping) {
        const stmt = this.db.prepare(`
      INSERT INTO symbol_mappings (
        id, normalized_symbol, binance_symbol, bybit_symbol, base_asset, quote_asset,
        contract_multiplier, min_quantity, quantity_step, price_tick,
        binance_status, bybit_status, is_active, last_validated_at, expires_at
      ) VALUES (
        @id, @normalized_symbol, @binance_symbol, @bybit_symbol, @base_asset, @quote_asset,
        @contract_multiplier, @min_quantity, @quantity_step, @price_tick,
        @binance_status, @bybit_status, @is_active, @last_validated_at, @expires_at
      )
      ON CONFLICT(normalized_symbol) DO UPDATE SET
        binance_symbol = excluded.binance_symbol,
        bybit_symbol = excluded.bybit_symbol,
        contract_multiplier = excluded.contract_multiplier,
        min_quantity = excluded.min_quantity,
        quantity_step = excluded.quantity_step,
        price_tick = excluded.price_tick,
        binance_status = excluded.binance_status,
        bybit_status = excluded.bybit_status,
        is_active = excluded.is_active,
        last_validated_at = excluded.last_validated_at,
        expires_at = excluded.expires_at
    `);
        stmt.run(mapping);
    }
    getByNormalized(normalizedSymbol) {
        return this.db
            .prepare('SELECT * FROM symbol_mappings WHERE normalized_symbol = ? AND is_active = 1')
            .get(normalizedSymbol);
    }
    getAllActive() {
        return this.db
            .prepare('SELECT * FROM symbol_mappings WHERE is_active = 1')
            .all();
    }
}
export class TradeRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    create(trade) {
        const stmt = this.db.prepare(`
      INSERT INTO trades (
        id, coin, binance_symbol, bybit_symbol, funding_event_id, state, direction,
        target_notional_usd, binance_entry_qty, bybit_entry_qty, binance_exit_qty, bybit_exit_qty,
        expected_funding_edge_pct, expected_net_profit_usd, realized_pnl_usd,
        total_fees_usd, total_funding_usd, net_pnl_usd, is_simulated,
        error_message, created_at, updated_at, completed_at
      ) VALUES (
        @id, @coin, @binance_symbol, @bybit_symbol, @funding_event_id, @state, @direction,
        @target_notional_usd, @binance_entry_qty, @bybit_entry_qty, @binance_exit_qty, @bybit_exit_qty,
        @expected_funding_edge_pct, @expected_net_profit_usd, @realized_pnl_usd,
        @total_fees_usd, @total_funding_usd, @net_pnl_usd, @is_simulated,
        @error_message, @created_at, @updated_at, @completed_at
      )
    `);
        stmt.run(trade);
    }
    update(trade) {
        const fields = Object.keys(trade).filter((k) => k !== 'id');
        if (fields.length === 0)
            return;
        const setClause = fields.map((k) => `${k} = @${k}`).join(', ');
        const stmt = this.db.prepare(`UPDATE trades SET ${setClause}, updated_at = @updated_at WHERE id = @id`);
        stmt.run({
            ...trade,
            updated_at: new Date().toISOString(),
        });
    }
    getById(id) {
        return this.db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
    }
    getActiveTrades() {
        return this.db
            .prepare(`SELECT * FROM trades WHERE state NOT IN ('COMPLETED', 'FAILED', 'REJECTED')`)
            .all();
    }
    getByFundingEvent(fundingEventId) {
        return this.db
            .prepare('SELECT * FROM trades WHERE funding_event_id = ?')
            .get(fundingEventId);
    }
}
export class OrderRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    create(order) {
        const stmt = this.db.prepare(`
      INSERT INTO orders (
        id, trade_id, exchange, client_order_id, exchange_order_id, symbol, side,
        order_type, requested_quantity, executed_quantity, average_price,
        status, is_reduce_only, is_recovery, purpose, error_message, created_at, updated_at
      ) VALUES (
        @id, @trade_id, @exchange, @client_order_id, @exchange_order_id, @symbol, @side,
        @order_type, @requested_quantity, @executed_quantity, @average_price,
        @status, @is_reduce_only, @is_recovery, @purpose, @error_message, @created_at, @updated_at
      )
    `);
        stmt.run(order);
    }
    update(order) {
        const fields = Object.keys(order).filter((k) => k !== 'id');
        if (fields.length === 0)
            return;
        const setClause = fields.map((k) => `${k} = @${k}`).join(', ');
        const stmt = this.db.prepare(`UPDATE orders SET ${setClause}, updated_at = @updated_at WHERE id = @id`);
        stmt.run({
            ...order,
            updated_at: new Date().toISOString(),
        });
    }
    getByClientOrderId(clientOrderId) {
        return this.db
            .prepare('SELECT * FROM orders WHERE client_order_id = ?')
            .get(clientOrderId);
    }
    getByTradeId(tradeId) {
        return this.db
            .prepare('SELECT * FROM orders WHERE trade_id = ? ORDER BY created_at ASC')
            .all(tradeId);
    }
}
export class FillRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    create(fill) {
        const stmt = this.db.prepare(`
      INSERT INTO fills (
        id, order_id, trade_id, exchange, exchange_execution_id, price, quantity, fee, fee_currency, timestamp
      ) VALUES (
        @id, @order_id, @trade_id, @exchange, @exchange_execution_id, @price, @quantity, @fee, @fee_currency, @timestamp
      )
    `);
        stmt.run(fill);
    }
    getByTradeId(tradeId) {
        return this.db
            .prepare('SELECT * FROM fills WHERE trade_id = ? ORDER BY timestamp ASC')
            .all(tradeId);
    }
}
export class FundingEventRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    upsert(event) {
        const stmt = this.db.prepare(`
      INSERT INTO funding_events (
        id, coin, binance_funding_rate, bybit_funding_rate, funding_rate_diff,
        binance_funding_time, bybit_funding_time, target_funding_time, is_aligned, status, created_at
      ) VALUES (
        @id, @coin, @binance_funding_rate, @bybit_funding_rate, @funding_rate_diff,
        @binance_funding_time, @bybit_funding_time, @target_funding_time, @is_aligned, @status, @created_at
      )
      ON CONFLICT(id) DO UPDATE SET
        binance_funding_rate = excluded.binance_funding_rate,
        bybit_funding_rate = excluded.bybit_funding_rate,
        funding_rate_diff = excluded.funding_rate_diff,
        status = excluded.status
    `);
        stmt.run(event);
    }
    getById(id) {
        return this.db.prepare('SELECT * FROM funding_events WHERE id = ?').get(id);
    }
}
export class FundingTransactionRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    create(tx) {
        const stmt = this.db.prepare(`
      INSERT INTO funding_transactions (
        id, trade_id, exchange, symbol, funding_rate, position_notional, payment_amount, asset, timestamp, is_simulated
      ) VALUES (
        @id, @trade_id, @exchange, @symbol, @funding_rate, @position_notional, @payment_amount, @asset, @timestamp, @is_simulated
      )
    `);
        stmt.run(tx);
    }
    getByTradeId(tradeId) {
        return this.db
            .prepare('SELECT * FROM funding_transactions WHERE trade_id = ? ORDER BY timestamp ASC')
            .all(tradeId);
    }
}
export class PositionSnapshotRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    create(snapshot) {
        const stmt = this.db.prepare(`
      INSERT INTO position_snapshots (
        id, trade_id, exchange, symbol, side, quantity, entry_price, mark_price, unrealized_pnl, leverage, timestamp
      ) VALUES (
        @id, @trade_id, @exchange, @symbol, @side, @quantity, @entry_price, @mark_price, @unrealized_pnl, @leverage, @timestamp
      )
    `);
        stmt.run(snapshot);
    }
    getLatestByTrade(tradeId) {
        return this.db
            .prepare(`
        SELECT * FROM position_snapshots 
        WHERE trade_id = ? 
        ORDER BY timestamp DESC LIMIT 2
      `)
            .all(tradeId);
    }
}
export class StateTransitionRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    record(transition) {
        const stmt = this.db.prepare(`
      INSERT INTO state_transitions (
        id, trade_id, from_state, to_state, reason, metadata, timestamp
      ) VALUES (
        @id, @trade_id, @from_state, @to_state, @reason, @metadata, @timestamp
      )
    `);
        stmt.run(transition);
    }
    getByTradeId(tradeId) {
        return this.db
            .prepare('SELECT * FROM state_transitions WHERE trade_id = ? ORDER BY timestamp ASC')
            .all(tradeId);
    }
}
export class RiskEventRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    record(event) {
        const stmt = this.db.prepare(`
      INSERT INTO risk_events (
        id, event_type, rule_name, trade_id, details, timestamp
      ) VALUES (
        @id, @event_type, @rule_name, @trade_id, @details, @timestamp
      )
    `);
        stmt.run(event);
    }
    getRecent(limit = 20) {
        return this.db
            .prepare('SELECT * FROM risk_events ORDER BY timestamp DESC LIMIT ?')
            .all(limit);
    }
}
export class DailySummaryRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    getOrCreateToday() {
        const today = new Date().toISOString().slice(0, 10);
        let record = this.db.prepare('SELECT * FROM daily_summaries WHERE date = ?').get(today);
        if (!record) {
            const now = new Date().toISOString();
            this.db.prepare(`
        INSERT INTO daily_summaries (date, trade_count, total_trading_pnl_usd, total_funding_pnl_usd, total_fees_usd, net_pnl_usd, loss_limit_hit, created_at, updated_at)
        VALUES (?, 0, '0', '0', '0', '0', 0, ?, ?)
      `).run(today, now, now);
            record = this.db.prepare('SELECT * FROM daily_summaries WHERE date = ?').get(today);
        }
        return record;
    }
    addTradeResult(tradingPnl, fundingPnl, fees, hitLossLimit = false) {
        const summary = this.getOrCreateToday();
        const newCount = summary.trade_count + 1;
        const newTradingPnl = toDecimal(summary.total_trading_pnl_usd).plus(tradingPnl);
        const newFundingPnl = toDecimal(summary.total_funding_pnl_usd).plus(fundingPnl);
        const newFees = toDecimal(summary.total_fees_usd).plus(fees);
        const newNetPnl = toDecimal(summary.net_pnl_usd).plus(tradingPnl).plus(fundingPnl).minus(fees);
        const now = new Date().toISOString();
        this.db.prepare(`
      UPDATE daily_summaries SET
        trade_count = ?,
        total_trading_pnl_usd = ?,
        total_funding_pnl_usd = ?,
        total_fees_usd = ?,
        net_pnl_usd = ?,
        loss_limit_hit = ?,
        updated_at = ?
      WHERE date = ?
    `).run(newCount, newTradingPnl.toString(), newFundingPnl.toString(), newFees.toString(), newNetPnl.toString(), hitLossLimit || summary.loss_limit_hit === 1 ? 1 : 0, now, summary.date);
    }
}
//# sourceMappingURL=repositories.js.map