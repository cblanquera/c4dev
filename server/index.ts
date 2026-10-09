/** Entry point: opens the database, starts every project's coordinator, the assistant and the HTTP server. */
import fs from 'node:fs';
import path from 'node:path';
import { openDb, closeDb } from './db.ts';
import { DATA_DIR, assistantSettings, defaultSettings, initSettings, listProjects, settings } from './settings.ts';
import { ensureDemoRepo } from './git.ts';
import { Factory } from './factory.ts';
import { Assistant } from './assistant.ts';
import { createApp } from './app.ts';
import { ClaudeDriver } from './agents/claude.ts';
import { SimulatedDriver } from './agents/simulated.ts';
import type { Driver } from './agents/driver.ts';

const PORT = Number(process.env.PORT ?? 4400);

fs.mkdirSync(DATA_DIR, { recursive: true });
openDb(path.join(DATA_DIR, 'factory.db'));
initSettings();

const demoRepo = defaultSettings().repoPath;
if (listProjects().some((p) => p.settings.repoPath === demoRepo)) await ensureDemoRepo(demoRepo);

const simulated = new SimulatedDriver();
/** Claude drivers read their model lazily, so one per project follows that project's settings. */
const claude = new Map<number, ClaudeDriver>();
function driverFor(projectId: number): Driver {
  if (settings(projectId).driver !== 'claude') return simulated;
  let driver = claude.get(projectId);
  if (!driver) claude.set(projectId, driver = new ClaudeDriver(() => settings(projectId).model));
  return driver;
}
const assistantClaude = new ClaudeDriver(() => assistantSettings().model);

const factory = new Factory(driverFor);
const assistant = new Assistant(factory, () => (assistantSettings().driver === 'claude' ? assistantClaude : simulated));
const app = createApp(factory, assistant);
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Software factory on http://localhost:${PORT} (${listProjects().map((p) => `${p.name}: ${p.settings.driver}`).join(', ')})`);
});
factory.start();
assistant.start();

async function shutdown() {
  server.close();
  await assistant.stop();
  await factory.stop();
  closeDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
