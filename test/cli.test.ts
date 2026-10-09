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
