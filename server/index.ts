/** Entry point: opens the database, starts every project's coordinator, the assistant and the HTTP server. */
import fs from 'node:fs';
import path from 'node:path';
import { openDb, closeDb } from './db.ts';
import { CLAUDE_MODELS, DATA_DIR, defaultSettings, initSettings, listProjects, refreshRemote } from './settings.ts';
import { assistantProfile, seedProfiles } from './profiles.ts';
import { refreshProviders } from './providers.ts';
import { ensureDemoRepo } from './git.ts';
import { Factory } from './factory.ts';
import { Assistant } from './assistant.ts';
import { createApp } from './app.ts';
import { ClaudeDriver } from './agents/claude.ts';
import { CliDriver } from './agents/cli.ts';
import { SimulatedDriver } from './agents/simulated.ts';
import type { Driver } from './agents/driver.ts';
import type { DriverName } from './types.ts';

const PORT = Number(process.env.PORT ?? 4400);

fs.mkdirSync(DATA_DIR, { recursive: true });
openDb(path.join(DATA_DIR, 'factory.db'));
initSettings();
seedProfiles();

const demoRepo = defaultSettings().repoPath;
if (listProjects().some((p) => p.settings.repoPath === demoRepo)) await ensureDemoRepo(demoRepo);

const simulated = new SimulatedDriver();
/**
 * One driver per provider. Each run's model comes from its agent profile; the
 * default here is used when the profile leaves it empty (Claude's first known
 * model, or the CLI's own default).
 */
const drivers: Partial<Record<DriverName, Driver>> = { simulated };
function driverFor(provider: DriverName): Driver {
  return drivers[provider] ??= provider === 'claude' ? new ClaudeDriver(() => CLAUDE_MODELS[0]) : new CliDriver(provider as Exclude<DriverName, 'simulated' | 'claude'>, () => '');
}


const factory = new Factory(driverFor);
// The assistant is the Chief of Staff profile, running on that profile's provider.
const assistant = new Assistant(factory, () => driverFor(assistantProfile().provider));
const app = createApp(factory, assistant);
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Software factory on http://localhost:${PORT} (${listProjects().map((p) => p.name).join(', ')})`);
});
factory.start();
assistant.start();
for (const project of listProjects()) void refreshRemote(project.id);
void refreshProviders();

async function shutdown() {
  server.close();
  await assistant.stop();
  await factory.stop();
  closeDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
