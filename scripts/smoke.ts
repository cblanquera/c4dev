/**
 * Smoke test for the real drivers: each provider plans (read-only) and does a
 * small worker task in a throwaway git repository, with a cheap model where
 * one is known. It spends real tokens, so it never runs in CI.
 *
 *   npm run smoke                        every switched-on, installed provider
 *   npm run smoke -- codex pi            just these
 *   npm run smoke -- opencode --model opencode=openrouter/~anthropic/claude-haiku-latest
 *   npm run smoke -- codex --record      also save the raw CLI output under test-results/fixtures/
 *
 * Checks: the planner returns subtasks and leaves the repository untouched,
 * the worker writes the file it was asked for, tool calls are logged and
 * usage is reported. After a CLI update, a passing run means the parsers
 * still read it: update TESTED_VERSIONS in server/providers.ts. If the format
 * changed, compare the recorded output with test/fixtures/providers and
 * update the fixtures and parsers together.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Throwaway data, so nothing touches the real .factory.
process.env.FACTORY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-smoke-data-'));

const { git, run } = await import('../server/shell.ts');
const { CLAUDE_MODELS } = await import('../server/settings.ts');
const { ClaudeDriver } = await import('../server/agents/claude.ts');
const { CliDriver } = await import('../server/agents/cli.ts');
const { PROVIDERS } = await import('../server/types.ts');
type ProviderId = (typeof PROVIDERS)[number];
type Driver = import('../server/agents/driver.ts').Driver;
type AgentContext = import('../server/agents/driver.ts').AgentContext;

/** Cheap defaults; '' leaves the CLI's own default model. */
const MODELS: Record<ProviderId, string> = { claude: CLAUDE_MODELS.find((m) => m.includes('haiku')) ?? '', codex: '', opencode: '', pi: '' };
const LIMITS = { maxTurns: 30, runMinutes: 10 };
const RECORD_DIR = path.resolve('test-results', 'fixtures');

const args = process.argv.slice(2);
const record = args.includes('--record');
const chosen: ProviderId[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--record') continue;
  if (args[i] === '--model') {
    const [provider, ...model] = (args[++i] ?? '').split('=');
    if (!PROVIDERS.includes(provider as ProviderId) || !model.length) throw new Error('Use --model <provider>=<model>');
    MODELS[provider as ProviderId] = model.join('=');
    continue;
  }
  if (!PROVIDERS.includes(args[i] as ProviderId)) throw new Error(`Unknown provider ${args[i]}; choose from ${PROVIDERS.join(', ')}`);
  chosen.push(args[i] as ProviderId);
}

/** Installed providers, when none are named (Claude's SDK is bundled, so it's always there). */
async function installed(): Promise<ProviderId[]> {
  const found: ProviderId[] = [];
  for (const id of PROVIDERS) {
    if (id === 'claude' || (await run(`command -v ${id}`, { cwd: process.cwd() })).code === 0) found.push(id);
  }
  return found;
}

async function throwawayRepo(): Promise<string> {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-')));
  fs.writeFileSync(path.join(repo, 'README.md'), '# Greeter\n\nA tiny library that greets people.\n');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'greet.js'), 'export const greet = (name) => `Hello, ${name}`;\n');
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'add', '-A');
  await git(repo, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', 'commit', '-q', '-m', 'Initial');
  return repo;
}

function driverFor(id: ProviderId): Driver {
  if (id === 'claude') return new ClaudeDriver(() => MODELS.claude);
  if (!record) return new CliDriver(id, () => MODELS[id]);
  fs.mkdirSync(RECORD_DIR, { recursive: true });
  const files = new Set<string>();
  return new CliDriver(id, () => MODELS[id], {
    record: (access, line) => {
      const file = path.join(RECORD_DIR, `${id}-${access}.jsonl`);
      if (!files.has(file)) fs.writeFileSync(file, '');
      files.add(file);
      if (line.trim()) fs.appendFileSync(file, `${line}\n`);
    },
  });
}

interface Outcome { provider: ProviderId; checks: [string, boolean, string?][]; tokens: number; costUsd: number }

async function smoke(id: ProviderId): Promise<Outcome> {
  const outcome: Outcome = { provider: id, checks: [], tokens: 0, costUsd: 0 };
  const check = (name: string, ok: boolean, detail?: string) => outcome.checks.push([name, ok, detail]);
  const repo = await throwawayRepo();
  const tools: string[] = [];
  const ctx: AgentContext = {
    signal: new AbortController().signal,
    log: (level, text) => { if (level === 'oneliner') tools.push(text); },
    usage: (u) => {
      outcome.tokens += u.inputTokens + u.outputTokens;
      outcome.costUsd += u.costUsd;
    },
    profile: { id: 0, name: 'Smoke', job: 'developer', title: 'Smoke test', context: '', model: MODELS[id], skills: [], pluginDir: null, limits: LIMITS },
  };
  const card = { id: 1, title: 'Add a farewell', description: 'Add farewell(name) beside greet.', instructions: '## Objective\nAdd `farewell(name)` to src/greet.js returning `Goodbye, <name>`, with a test.' } as never;
  const driver = driverFor(id);
  try {
    const plan = await driver.plan({ card, references: [], repoPath: repo }, ctx);
    check('plans subtasks', plan.length > 0, `${plan.length} subtask(s)`);
    const dirty = await git(repo, 'status', '--porcelain');
    check('planning leaves the repository untouched', !dirty, dirty || undefined);
  } catch (err) {
    check('plans subtasks', false, err instanceof Error ? err.message : String(err));
  }
  try {
    const subtask = { id: 1, seq: 1, title: 'Write hello.txt', instructions: 'Create hello.txt', kind: 'build' } as never;
    const result = await driver.work({
      card, subtask, cwd: repo, env: {}, model: MODELS[id],
      prompt: 'Create a file named hello.txt in the current directory containing exactly the text: hi\nDo nothing else, then summarise what you did.',
    }, ctx);
    const file = path.join(repo, 'hello.txt');
    check('the worker writes the file', fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() === 'hi');
    check('the worker summarises', !!result.summary, result.summary.slice(0, 80));
  } catch (err) {
    check('the worker writes the file', false, err instanceof Error ? err.message : String(err));
  }
  check('tool calls are logged', tools.length > 0, tools.slice(0, 3).join(' | '));
  check('usage is reported', outcome.tokens > 0, `${outcome.tokens} tokens, $${outcome.costUsd.toFixed(4)}`);
  fs.rmSync(repo, { recursive: true, force: true });
  return outcome;
}

const targets = chosen.length ? chosen : await installed();
let failed = false;
for (const id of targets) {
  const versionRun = id === 'claude' ? null : await run(`${id} --version`, { cwd: process.cwd() });
  console.log(`\n${id}${versionRun ? ` (${versionRun.output.trim().split('\n')[0]})` : ' (Agent SDK)'} · model ${MODELS[id] || 'CLI default'}`);
  const outcome = await smoke(id);
  for (const [name, ok, detail] of outcome.checks) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
    failed ||= !ok;
  }
}
if (record) console.log(`\nRaw output recorded in ${RECORD_DIR}`);
fs.rmSync(process.env.FACTORY_DATA!, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
