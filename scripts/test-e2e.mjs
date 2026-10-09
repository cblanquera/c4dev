/** Build and test against isolated data on a devmetrics-managed port. */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-e2e-'));
let server;
let runner;

/** Keep the managed server and the test process under the same cleanup boundary. */
function stop() {
  runner?.kill('SIGTERM');
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

try {
  execFileSync('devmetrics', ['list'], { stdio: 'ignore' });
  server = JSON.parse(execFileSync('devmetrics', [
    'start', '--json', '--new', '--project', 'c4dev-e2e',
    '--summary', 'Isolated desktop and mobile acceptance tests',
    '--', 'PORT={port} node server/index.ts',
  ], { encoding: 'utf8', env: { ...process.env, FACTORY_DATA: dataDir, FACTORY_SIM_SPEED: '0.15' } }));
  console.log(`Acceptance server: ${server.url} (expires ${server.stopsAt}; stopped when tests finish)`);
  const ready = await fetch(`${server.url}/api/state`);
  if (!ready.ok) throw new Error(`Acceptance server returned ${ready.status}`);
  runner = spawn('npx', ['playwright', 'test', ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_BASE_URL: server.url },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    runner.once('error', reject);
    runner.once('exit', (code) => resolve(code ?? 1));
  });
} finally {
  if (server) execFileSync('devmetrics', ['stop', String(server.port)], { stdio: 'inherit' });
  fs.rmSync(dataDir, { recursive: true, force: true });
}
