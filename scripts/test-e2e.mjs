/**
 * Build and test against isolated data on a devmetrics-managed port. In CI
 * (CI set, no devmetrics) the server is started directly on a free port.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-e2e-'));
/**
 * A stand-in TypeSafe API so specs can add Jev without the real service: the
 * key `test-jev-key` is accepted, and decisions fail (so the factory falls back,
 * as without Jev) except a description containing VAGUE-E2E, which is too vague.
 */
const jev = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.headers.authorization !== 'Bearer test-jev-key') return res.writeHead(401).end();
    if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"models":[{"name":"jev-latest"}]}');
    const { state, questions } = JSON.parse(body || '{}');
    if (questions?.specificity && String(state?.task_description).includes('VAGUE-E2E')) {
      return res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ model: 'jev-latest', answers: { specificity: { type: 'score', score: 0.1, confidence: 0.95 } }, usage: { input_tokens: 10, output_tokens: 1 } }));
    }
    res.writeHead(500).end();
  });
});
await new Promise((resolve) => jev.listen(0, '127.0.0.1', resolve));

// No OS dialogs during tests: the in-app folder picker stands in, as on a headless machine.
const serverEnv = {
  ...process.env, FACTORY_DATA: dataDir, FACTORY_SIM_SPEED: '0.15', FACTORY_NATIVE_DIALOGS: '0',
  TYPESAFE_BASE_URL: `http://127.0.0.1:${jev.address().port}`,
};
let server;
let direct;
let runner;

/** Keep the managed server and the test process under the same cleanup boundary. */
function stop() {
  runner?.kill('SIGTERM');
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

/** CI has no devmetrics: run the server directly, stopped when the tests finish. */
async function startDirect() {
  const port = await freePort();
  direct = spawn('node', ['server/index.ts'], { stdio: 'inherit', env: { ...serverEnv, PORT: String(port) } });
  return { url: `http://localhost:${port}`, port };
}

function startManaged() {
  execFileSync('devmetrics', ['list'], { stdio: 'ignore' });
  const managed = JSON.parse(execFileSync('devmetrics', [
    'start', '--json', '--new', '--project', 'c4dev-e2e',
    '--summary', 'Isolated desktop and mobile acceptance tests',
    '--', 'PORT={port} node server/index.ts',
  ], { encoding: 'utf8', env: serverEnv }));
  console.log(`Acceptance server: ${managed.url} (expires ${managed.stopsAt}; stopped when tests finish)`);
  return managed;
}

/** Waits for the server to create its API token and answer with it. */
async function ready(url) {
  const tokenFile = path.join(dataDir, 'auth-token');
  for (let i = 0; i < 300; i++) {
    if (fs.existsSync(tokenFile)) {
      const token = fs.readFileSync(tokenFile, 'utf8').trim();
      const res = await fetch(`${url}/api/state`, { headers: { 'x-factory-token': token } }).catch(() => null);
      if (res?.ok) return token;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Acceptance server at ${url} didn't start`);
}

try {
  const target = process.env.CI ? await startDirect() : (server = startManaged());
  // Specs' direct API calls need the token the server creates on startup.
  const token = await ready(target.url);
  runner = spawn('npx', ['playwright', 'test', ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_BASE_URL: target.url, FACTORY_TOKEN: token },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    runner.once('error', reject);
    runner.once('exit', (code) => resolve(code ?? 1));
  });
} finally {
  if (server) execFileSync('devmetrics', ['stop', String(server.port)], { stdio: 'inherit' });
  if (direct) {
    direct.kill('SIGTERM');
    await new Promise((r) => (direct.exitCode !== null ? r() : direct.once('exit', r)));
  }
  jev.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
