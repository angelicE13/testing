import fs from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { startScheduler } from './scheduler.js';

const config = loadConfig();
fs.mkdirSync(config.reportsDir, { recursive: true });
const store = openDb(config.dbFile);
const app = createApp(store, config);
const scheduler = startScheduler(store, config);

const server = app.listen(config.port, () => {
  console.log(`Mileage logbook running on http://localhost:${config.port}`);
  console.log(`Time zone ${config.timezone} · unit ${config.unit} · data in ${config.dataDir}`);
  if (!config.password) console.log('No APP_PASSWORD set — anyone who can reach this server can use it.');
});

const shutdown = () => {
  scheduler.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
