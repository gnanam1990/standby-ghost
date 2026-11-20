import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { startServer } from './http/server.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const handle = await startServer(config, db);

console.log(`standby-ghost listening on http://localhost:${handle.port}`);
console.log(`database: ${config.dbPath}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void handle.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}
