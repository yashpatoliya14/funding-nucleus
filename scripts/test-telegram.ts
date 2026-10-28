import { loadConfig } from '../src/config/env.js';
import { TelegramNotifier } from '../src/notifications/telegram.js';

async function main() {
  console.log('\n======================================================');
  console.log('       TELEGRAM NOTIFICATION CONNECTIVITY TEST        ');
  console.log('======================================================\n');

  const config = loadConfig();

  if (!config.env.TELEGRAM_BOT_TOKEN || !config.env.TELEGRAM_CHAT_ID) {
    console.error('Error: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured in .env!');
    console.log('Please add them to your .env file:');
    console.log('TELEGRAM_BOT_TOKEN=123456789:ABCDefgh...');
    console.log('TELEGRAM_CHAT_ID=123456789\n');
    process.exit(1);
  }

  const notifier = new TelegramNotifier({
    enabled: true,
    botToken: config.env.TELEGRAM_BOT_TOKEN,
    chatId: config.env.TELEGRAM_CHAT_ID,
    durationDays: config.env.TELEGRAM_MONITORING_DURATION_DAYS,
  });

  console.log('[*] Testing Telegram API credentials and chat connectivity...');
  const connTest = await notifier.testConnection();

  if (!connTest.ok) {
    console.error(`[✗] Connection Failed: ${connTest.message}`);
    process.exit(1);
  }

  console.log(`[✓] ${connTest.message}`);
  console.log(`[*] Sending test alert message to Chat ID ${config.env.TELEGRAM_CHAT_ID}...`);

  await notifier.sendAlert(
    'Connectivity Test Successful',
    'Hello! This is a test alert from your Binance–Bybit Funding Arbitrage Bot.\nMonitoring mode is active and operational.',
    'INFO'
  );

  console.log('[✓] Test notification dispatched successfully!\n');
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
