import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import yaml from 'yaml';
import { z } from 'zod';
import { AppConfig, AppConfigSchema } from './schema.js';

dotenv.config();

const EnvSchema = z.object({
  BINANCE_API_KEY: z.string().default(''),
  BINANCE_API_SECRET: z.string().default(''),
  BINANCE_TESTNET: z.string().default('false').transform((v) => v === 'true'),
  BYBIT_API_KEY: z.string().default(''),
  BYBIT_API_SECRET: z.string().default(''),
  BYBIT_TESTNET: z.string().default('false').transform((v) => v === 'true'),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_MONITORING_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  TELEGRAM_MONITORING_DURATION_DAYS: z
    .string()
    .default('3')
    .transform((v) => {
      const n = parseInt(v, 10);
      return isNaN(n) ? 3 : Math.min(7, Math.max(1, n));
    }),
  CONFIG_PATH: z.string().default('./config/config.example.yaml'),
  LOG_LEVEL: z.string().optional(),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

export interface FullConfig {
  appConfig: AppConfig;
  env: EnvConfig;
}

export function loadConfig(customConfigPath?: string): FullConfig {
  const env = EnvSchema.parse(process.env);
  const configPath = customConfigPath || env.CONFIG_PATH;

  let fileContent = '';
  const resolvedPath = path.resolve(process.cwd(), configPath);

  if (fs.existsSync(resolvedPath)) {
    fileContent = fs.readFileSync(resolvedPath, 'utf8');
  }

  const parsedYaml = fileContent ? yaml.parse(fileContent) : {};
  const appConfig = AppConfigSchema.parse(parsedYaml);

  // If live mode is selected, ensure non-empty API keys
  if (appConfig.app.mode === 'live') {
    if (!env.BINANCE_API_KEY || !env.BINANCE_API_SECRET) {
      throw new Error('Live mode requires BINANCE_API_KEY and BINANCE_API_SECRET');
    }
    if (!env.BYBIT_API_KEY || !env.BYBIT_API_SECRET) {
      throw new Error('Live mode requires BYBIT_API_KEY and BYBIT_API_SECRET');
    }
  }

  // Synchronize env overrides into appConfig
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    appConfig.monitoring.telegram_enabled = true;
    appConfig.monitoring.monitoring_enabled = env.TELEGRAM_MONITORING_ENABLED;
    appConfig.monitoring.duration_days = env.TELEGRAM_MONITORING_DURATION_DAYS;
  }

  return { appConfig, env };
}
