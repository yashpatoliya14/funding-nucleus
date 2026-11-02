import { z } from 'zod';
import { AppConfig } from './schema.js';
declare const EnvSchema: z.ZodObject<{
    BINANCE_API_KEY: z.ZodDefault<z.ZodString>;
    BINANCE_API_SECRET: z.ZodDefault<z.ZodString>;
    BINANCE_TESTNET: z.ZodPipe<z.ZodDefault<z.ZodString>, z.ZodTransform<boolean, string>>;
    BYBIT_API_KEY: z.ZodDefault<z.ZodString>;
    BYBIT_API_SECRET: z.ZodDefault<z.ZodString>;
    BYBIT_TESTNET: z.ZodPipe<z.ZodDefault<z.ZodString>, z.ZodTransform<boolean, string>>;
    TELEGRAM_BOT_TOKEN: z.ZodOptional<z.ZodString>;
    TELEGRAM_CHAT_ID: z.ZodOptional<z.ZodString>;
    TELEGRAM_MONITORING_ENABLED: z.ZodPipe<z.ZodDefault<z.ZodString>, z.ZodTransform<boolean, string>>;
    TELEGRAM_MONITORING_DURATION_DAYS: z.ZodPipe<z.ZodDefault<z.ZodString>, z.ZodTransform<number, string>>;
    TRADE_MARGIN_PER_LEG_USD: z.ZodPipe<z.ZodOptional<z.ZodString>, z.ZodTransform<number | undefined, string | undefined>>;
    MAX_NOTIONAL_PER_LEG_USD: z.ZodPipe<z.ZodOptional<z.ZodString>, z.ZodTransform<number | undefined, string | undefined>>;
    LEVERAGE_CAP: z.ZodPipe<z.ZodOptional<z.ZodString>, z.ZodTransform<number | undefined, string | undefined>>;
    AUTO_EXECUTE_TRADES: z.ZodPipe<z.ZodDefault<z.ZodString>, z.ZodTransform<boolean, string>>;
    CONFIG_PATH: z.ZodDefault<z.ZodString>;
    LOG_LEVEL: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type EnvConfig = z.infer<typeof EnvSchema>;
export interface FullConfig {
    appConfig: AppConfig;
    env: EnvConfig;
}
export declare function loadConfig(customConfigPath?: string): FullConfig;
export {};
//# sourceMappingURL=env.d.ts.map