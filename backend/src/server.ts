import { createApp } from './app.js';
import { loadConfig } from './config.js';
try {
  const config = loadConfig();
  createApp(config).listen(config.port, 'localhost', () => console.info(`[HTTP] Backend ready on port ${config.port}`));
} catch (error) {
  console.error('[CONFIG]', error instanceof Error ? error.message : 'Invalid configuration');
  process.exit(1);
}
