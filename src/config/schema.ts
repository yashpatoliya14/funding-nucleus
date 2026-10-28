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
      entry_lead_minutes: z.number().positive().default(10),
      target_exit_delay_seconds: z.number().nonnegative().default(60),
      minimum_net_profit_usd: z.number().nonnegative().default(0.50),
      minimum_funding_edge_pct: z.number().nonnegative().default(0.05),
      risk_buffer_usd: z.number().nonnegative().default(0.10),
      require_aligned_funding_events: z.boolean().default(true),
    })
    .default({
      entry_lead_minutes: 10,
      target_exit_delay_seconds: 60,
      minimum_net_profit_usd: 0.50,
      minimum_funding_edge_pct: 0.05,
      risk_buffer_usd: 0.10,
      require_aligned_funding_events: true,
    }),
  execution: z
    .object({
      order_type: z.literal('MARKET').default('MARKET'),
      parallel_entry: z.boolean().default(true),
      maximum_unhedged_seconds: z.number().positive().default(10),
      maximum_recovery_seconds: z.number().positive().default(15),
      maximum_slippage_bps: z.number().positive().default(10),
      maximum_notional_mismatch_pct: z.number().nonnegative().default(0.5),
      reduce_only_exits: z.boolean().default(true),
    })
    .default({
      order_type: 'MARKET',
      parallel_entry: true,
      maximum_unhedged_seconds: 10,
      maximum_recovery_seconds: 15,
      maximum_slippage_bps: 10,
      maximum_notional_mismatch_pct: 0.5,
      reduce_only_exits: true,
    }),
  risk: z
    .object({
      default_leverage_cap: z.number().positive().default(5),
      maximum_notional_per_leg_usd: z.number().positive().default(100),
      maximum_concurrent_trades: z.number().int().positive().default(1),
      maximum_daily_loss_usd: z.number().positive().default(5),
      maximum_aggregate_notional_usd: z.number().positive().default(200),
    })
    .default({
      default_leverage_cap: 5,
      maximum_notional_per_leg_usd: 100,
      maximum_concurrent_trades: 1,
      maximum_daily_loss_usd: 5,
      maximum_aggregate_notional_usd: 200,
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

export type AppConfig = z.infer<typeof AppConfigSchema>;
