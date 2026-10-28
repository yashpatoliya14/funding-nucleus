import { loadConfig } from './config/env.js';
import { FundingArbitrageApp } from './app.js';
import { logger } from './utils/logger.js';

async function main() {
  try {
    const config = loadConfig();
    const app = new FundingArbitrageApp(config);

    const shutdown = () => {
      logger.info('Termination signal received. Shutting down gracefully...');
      app.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    process.on('unhandledRejection', (reason) => {
      logger.error({ reason }, 'Unhandled Promise Rejection');
    });

    process.on('uncaughtException', (err) => {
      logger.fatal({ err: err?.message, stack: err?.stack }, 'Uncaught Exception! Shutting down');
      app.stop();
      process.exit(1);
    });

    await app.start();
  } catch (err: any) {
    logger.fatal({ err: err?.message }, 'Application fatal startup error');
    process.exit(1);
  }
}

main();
