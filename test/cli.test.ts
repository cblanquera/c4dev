/**
 * Agent CLI drivers, without calling any CLI: commands are checked for each
 * role's access, and parsers run on output recorded from the real CLIs
 * (test/fixtures/providers, captured in a throwaway repository).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cliCommand, extractJson, parseLine, type CliEvent, type CliProvider } from '../server/agents/cli.ts';

const CWD = '/private/tmp/smoke-Z0AI';

function events(provider: CliProvider, fixture: string, model = ''): CliEvent[] {
  return fs.readFileSync(new URL(`./fixtures/providers/${fixture}.jsonl`, import.meta.url), 'utf8')
    .split('\n').map((line) => parseLine(provider, line, CWD, model)).filter((e): e is CliEvent => !!e);
}
const tools = (list: CliEvent[]) => list.filter((e) => e.tool).map((e) => e.tool);
const lastText = (list: CliEvent[]) => list.filter((e) => e.text).at(-1)?.text;
const usage = (list: CliEvent[]) => list.filter((e) => e.usage).map((e) => e.usage!);

test('read-only roles never get write access on any CLI', () => {
  const read = (provider: CliProvider) => cliCommand({ provider, cwd: '/repo', prompt: 'Plan this', model: '', access: 'read' });
  const write = (provider: CliProvider) => cliCommand({ provider, cwd: '/repo', prompt: 'Build this', model: 'm1', access: 'write' });

  assert.deepEqual(read('codex').slice(0, 8), ['codex', 'exec', '--json', '--skip-git-repo-check', '-C', '/repo', '-s', 'read-only']);
  assert.ok(!read('codex').some((a) => /workspace-write|danger|bypass/.test(a)));
  assert.ok(write('codex').includes('workspace-write') && write('codex').includes('m1'));
  assert.ok(!write('codex').some((a) => /danger|bypass/.test(a)), 'workers stay inside the sandbox');

  assert.deepEqual(read('opencode').slice(0, 8), ['opencode', 'run', '--format', 'json', '--dir', '/repo', '--agent', 'plan']);
  assert.ok(!read('opencode').includes('--auto'), 'without --auto, anything needing approval is refused');
  assert.ok(write('opencode').includes('build') && write('opencode').includes('--auto'));

  const piTools = (argv: string[]) => argv[argv.indexOf('--tools') + 1];
  assert.equal(piTools(read('pi')), 'read,grep,find,ls');
  assert.equal(piTools(write('pi')), 'read,grep,find,ls,bash,edit,write');
  assert.ok(cliCommand({ provider: 'pi', cwd: '/x', prompt: 'p', model: '', access: 'none' }).includes('--no-tools'));
  for (const provider of ['codex', 'opencode', 'pi'] as const) assert.equal(read(provider).at(-1), 'Plan this', 'the prompt is the last argument');
});

test('Codex events become activity, an answer and usage', () => {
  const read = events('codex', 'codex-read', 'gpt-test');
  assert.deepEqual(tools(read), ['$ cat README.md']);
  assert.deepEqual(extractJson(lastText(read)!), { title: 'Smoke Repo' });
  assert.deepEqual(usage(read), [{ model: 'gpt-test', inputTokens: 45809 - 22656, outputTokens: 100, cacheReadTokens: 22656, cacheWriteTokens: 0, costUsd: 0 }]);
  assert.deepEqual(tools(events('codex', 'codex-write')), ["$ printf 'hi\\n' > hello.txt", '$ ls']);
});

test('OpenCode events become activity, an answer and usage with cost', () => {
  const read = events('opencode', 'opencode-read', 'openrouter/x');
  assert.deepEqual(tools(read), ['Glob README*', 'Read README.md']);
  assert.deepEqual(extractJson(lastText(read)!), { title: 'Smoke Repo' });
  const cost = usage(read).reduce((sum, u) => sum + u.costUsd, 0);
  assert.ok(Math.abs(cost - (0.002175775 + 0.00021477 + 0.00020028)) < 1e-9, String(cost));
  assert.deepEqual(tools(events('opencode', 'opencode-write')), ['Wrote hello.txt', '$ ls']);
  assert.deepEqual(parseLine('opencode', JSON.stringify({ type: 'error', error: { name: 'APIError', data: { message: 'No endpoints found that support tool use.' } } }), CWD, ''),
    { error: 'No endpoints found that support tool use.' });
});

test('Pi events become activity, an answer and usage with the model it used', () => {
  const read = events('pi', 'pi-read');
  assert.deepEqual(tools(read), ['Read README.md']);
  assert.deepEqual(extractJson(lastText(read)!), { title: 'Smoke Repo' });
  const [u] = usage(read);
  assert.equal(u.model, 'openrouter/moonshotai/kimi-k2.6');
  assert.ok(u.costUsd > 0 && u.inputTokens > 0 && u.outputTokens > 0);
  assert.deepEqual(tools(events('pi', 'pi-write')), ['Wrote hello.txt', '$ ls']);
  assert.equal(parseLine('pi', 'Not JSON at all', CWD, ''), null);
});

test('JSON answers are found plain, fenced or inside prose', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('Sure. {"a":3} Done.'), { a: 3 });
  assert.throws(() => extractJson('no json here'), /without the expected JSON/);
});

test('a CLI run stops at its turn and time limits, as a failure', async () => {
  const { CliDriver } = await import('../server/agents/cli.ts');
  const os = await import('node:os');
  const path = await import('node:path');
  // A stand-in codex that runs a command every 20 ms and never finishes.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fake-cli-'));
  const line = JSON.stringify({ type: 'item.started', item: { id: 'i', type: 'command_execution', command: 'ls', status: 'in_progress' } });
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nwhile true; do echo '${line}'; sleep 0.02; done\n`, { mode: 0o755 });
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${PATH}`;
  try {
    const driver = new CliDriver('codex', () => '');
    const ctx = (limits: { maxTurns: number; runMinutes: number }) => ({
      signal: new AbortController().signal, log: () => {}, usage: () => {},
      profile: { id: 1, name: 'Grace', job: 'coordinator' as const, title: 'Coordinator', context: '', model: '', skills: [], pluginDir: null, limits, contexts: [] },
    });
    const card = { id: 1, title: 't', instructions: 'i' } as any;
    const started = Date.now();
    await assert.rejects(driver.plan({ card, references: [], repoPath: bin }, ctx({ maxTurns: 3, runMinutes: 60 })), /Stopped after 3 turns/);
    await assert.rejects(driver.plan({ card, references: [], repoPath: bin }, ctx({ maxTurns: 10_000, runMinutes: 0.005 })), /Stopped after 0.005 minutes/);
    assert.ok(Date.now() - started < 10_000);
  } finally {
    process.env.PATH = PATH;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('contexts reach each CLI as MCP servers, with secrets in the environment, never on the command line', async () => {
  const { cliEnv } = await import('../server/agents/cli.ts');
  const stdio = { name: 'secrets', transport: 'stdio' as const, command: 'node', args: ['server.mjs'], env: { SECRET_WORD: 'pelican-42' }, url: '', headers: {}, readOnly: false };
  const http = { name: 'docs', transport: 'http' as const, command: '', args: [], env: {}, url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer sk-live-1' }, readOnly: true };
  const contexts = [stdio, http];

  const codex = cliCommand({ provider: 'codex', cwd: '/repo', prompt: 'Build this', model: '', access: 'write', contexts });
  assert.ok(codex.includes('mcp_servers.secrets.command="node"') && codex.includes('mcp_servers.secrets.args=["server.mjs"]'));
  assert.ok(codex.includes('mcp_servers.secrets.env_vars=["SECRET_WORD"]'), 'the value is forwarded from the environment');
  assert.ok(codex.includes('mcp_servers.secrets.default_tools_approval_mode="approve"'), "codex exec can't ask, so attaching the context approves it");
  assert.deepEqual(parseLine('codex', JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'secrets', tool: 'secret_word' } }), '/repo', ''), { tool: 'MCP secrets.secret_word' });
  assert.ok(codex.includes('mcp_servers.docs.url="https://mcp.example.com/mcp"'));
  assert.ok(codex.includes('mcp_servers.docs.env_http_headers={ "Authorization" = "FACTORY_MCP_1_0" }'));
  assert.ok(!codex.join(' ').includes('pelican-42') && !codex.join(' ').includes('sk-live-1'), 'no secret on the command line');
  assert.deepEqual(cliEnv('codex', contexts), { SECRET_WORD: 'pelican-42', FACTORY_MCP_1_0: 'Bearer sk-live-1' });

  // Codex hides credential-looking variables from commands unless a worker was given secrets.
  assert.ok(!codex.includes('shell_environment_policy.ignore_default_excludes=true'));
  assert.ok(cliCommand({ provider: 'codex', cwd: '/repo', prompt: 'p', model: '', access: 'write', secrets: true }).includes('shell_environment_policy.ignore_default_excludes=true'));
  assert.ok(!cliCommand({ provider: 'codex', cwd: '/repo', prompt: 'p', model: '', access: 'read', secrets: true }).includes('shell_environment_policy.ignore_default_excludes=true'));

  const opencode = JSON.parse(cliEnv('opencode', contexts).OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(opencode.mcp.secrets, { type: 'local', command: ['node', 'server.mjs'], environment: { SECRET_WORD: 'pelican-42' }, enabled: true });
  assert.deepEqual(opencode.mcp.docs, { type: 'remote', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer sk-live-1' }, enabled: true });
  assert.deepEqual(cliEnv('pi', contexts), {}, 'Pi has no MCP support');
  assert.deepEqual(cliEnv('codex', []), {});
});

test('knowledge folders need no MCP server: OpenCode is allowed to read them, every other CLI already can', async () => {
  const { cliEnv } = await import('../server/agents/cli.ts');
  const folder = { name: 'kb', transport: 'folder' as const, folder: '/work/kb', entry: '/work/kb/AGENTS.md', entryText: '# KB', command: '', args: [], env: {}, url: '', headers: {}, readOnly: true };
  assert.deepEqual(JSON.parse(cliEnv('opencode', [folder]).OPENCODE_CONFIG_CONTENT), { permission: { external_directory: { '/work/kb/**': 'allow' } } });
  assert.deepEqual(cliEnv('codex', [folder]), {});
  assert.deepEqual(cliEnv('pi', [folder]), {});
  assert.ok(!cliCommand({ provider: 'codex', cwd: '/repo', prompt: 'p', model: '', access: 'read', contexts: [] }).join(' ').includes('mcp_servers'));
});
