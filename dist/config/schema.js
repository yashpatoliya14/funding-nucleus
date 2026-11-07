import { z } from 'zod';
export const AppConfigSchema = z.object({
    app: z
        .object({
        mode: z.enum(['paper', 'live']).default('paper'),
        log_level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR', 'debug', 'info', 'warn', 'error']).default('INFO'),
    })
        .default({
        mode: 'paper',
        log_level: 'INFO',
    }),
    persistence: z
        .object({
        driver: z.literal('sqlite').default('sqlite'),
        path: z.string().default('./data/funding-bot.sqlite'),
    })
        .default({
        driver: 'sqlite',
        path: './data/funding-bot.sqlite',
    }),
    symbols: z
        .object({
        cache_ttl_hours: z.number().positive().default(24),
        refresh_trading_status_seconds: z.number().positive().default(30),
    })
        .default({
        cache_ttl_hours: 24,
        refresh_trading_status_seconds: 30,
    }),
    strategy: z
        .object({
        entry_lead_minutes: z.number().positive().default(2.5),
        target_exit_delay_seconds: z.number().nonnegative().default(15),
        minimum_net_profit_usd: z.number().nonnegative().default(0.01),
        minimum_funding_edge_pct: z.number().nonnegative().default(0.08),
        risk_buffer_usd: z.number().nonnegative().default(0.02),
        require_aligned_funding_events: z.boolean().default(true),
        cumulative_carry_enabled: z.boolean().default(true),
        carry_min_retention_edge_pct: z.number().nonnegative().default(0.08),
        margin_rebalance_warning_usd: z.number().nonnegative().default(3.50),
        auto_execute_trades: z.boolean().default(true),
        flash_mirage_filter_enabled: z.boolean().default(false),
        min_historical_consistency_pct: z.number().nonnegative().default(30.0),
        max_orderbook_spread_pct: z.number().nonnegative().default(0.80),
    })
        .default({
        entry_lead_minutes: 2.5,
        target_exit_delay_seconds: 15,
        minimum_net_profit_usd: 0.01,
        minimum_funding_edge_pct: 0.08,
        risk_buffer_usd: 0.02,
        require_aligned_funding_events: true,
        cumulative_carry_enabled: true,
        carry_min_retention_edge_pct: 0.08,
        margin_rebalance_warning_usd: 3.50,
        auto_execute_trades: true,
        flash_mirage_filter_enabled: false,
        min_historical_consistency_pct: 30.0,
        max_orderbook_spread_pct: 0.80,
    }),
    execution: z
        .object({
        order_type: z.literal('MARKET').default('MARKET'),
        parallel_entry: z.boolean().default(true),
        maximum_unhedged_seconds: z.number().positive().default(10),
        maximum_recovery_seconds: z.number().positive().default(15),
        maximum_slippage_bps: z.number().positive().default(10),
        maximum_notional_mismatch_pct: z.number().nonnegative().default(2.0),
        reduce_only_exits: z.boolean().default(true),
        maker_taker_hybrid_enabled: z.boolean().default(false),
        maker_timeout_seconds: z.number().positive().default(3),
    })
        .default({
        order_type: 'MARKET',
        parallel_entry: true,
        maximum_unhedged_seconds: 10,
        maximum_recovery_seconds: 15,
        maximum_slippage_bps: 10,
        maximum_notional_mismatch_pct: 2.0,
        reduce_only_exits: true,
        maker_taker_hybrid_enabled: false,
        maker_timeout_seconds: 3,
    }),
    risk: z
        .object({
        default_leverage_cap: z.number().positive().default(100),
        maximum_notional_per_leg_usd: z.number().positive().default(1500),
        trade_margin_per_leg_usd: z.number().positive().default(10),
        maximum_concurrent_trades: z.number().int().positive().default(1),
        maximum_daily_loss_usd: z.number().positive().default(10),
        maximum_aggregate_notional_usd: z.number().positive().default(3000),
    })
        .default({
        default_leverage_cap: 100,
        maximum_notional_per_leg_usd: 1500,
        trade_margin_per_leg_usd: 10,
        maximum_concurrent_trades: 1,
        maximum_daily_loss_usd: 10,
        maximum_aggregate_notional_usd: 3000,
    }),
    monitoring: z
        .object({
        telegram_enabled: z.boolean().default(false),
        monitoring_enabled: z.boolean().default(true),
        duration_days: z.number().min(1).max(7).default(3),
        daily_summary_hour_utc: z.number().min(0).max(23).default(15), // 15:30 UTC = 21:00 IST
        daily_summary_minute_utc: z.number().min(0).max(59).default(30),
    })
        .default({
        telegram_enabled: false,
        monitoring_enabled: true,
        duration_days: 3,
        daily_summary_hour_utc: 15,
        daily_summary_minute_utc: 30,
    }),
});
//# sourceMappingURL=schema.js.map