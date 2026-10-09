/** Entry point: opens the database, starts the coordinator and the HTTP server. */
import fs from 'node:fs';
import path from 'node:path';
import { openDb, closeDb } from './db.ts';
import { DATA_DIR, defaultSettings, initSettings, settings } from './settings.ts';
import { ensureDemoRepo } from './git.ts';
import { Coordinator } from './coordinator.ts';
import { createApp } from './app.ts';
import { ClaudeDriver } from './agents/claude.ts';
import { SimulatedDriver } from './agents/simulated.ts';
import type { Driver } from './agents/driver.ts';

const PORT = Number(process.env.PORT ?? 4400);

fs.mkdirSync(DATA_DIR, { recursive: true });
openDb(path.join(DATA_DIR, 'factory.db'));
initSettings();

const demoRepo = defaultSettings().repoPath;
if (settings().repoPath === demoRepo) await ensureDemoRepo(demoRepo);

const drivers: Record<string, Driver> = {
  simulated: new SimulatedDriver(),
  claude: new ClaudeDriver(() => settings().model),
};
const driver = () => drivers[settings().driver] ?? drivers.simulated;

const coordinator = new Coordinator(driver);
const app = createApp(coordinator, driver);
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Software factory on http://localhost:${PORT} (driver: ${settings().driver}, repo: ${settings().repoPath})`);
});
coordinator.start();

async function shutdown() {
  server.close();
  await coordinator.stop();
  closeDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
