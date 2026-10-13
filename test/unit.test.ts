import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeCoverage, parseCoverage } from '../server/coverage.ts';
import { deriveTitle, parseTags } from '../server/db.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isLoopbackHost, loadToken, withToken } from '../server/auth.ts';

test('parseCoverage reads common reporters', () => {
  assert.equal(parseCoverage('# all files | 92.31 | 85.00 | 100.00 |'), 92.31);
  assert.equal(parseCoverage('ℹ  math.js  | 50.00 | 100.00 | 100.00 |\nℹ all files | 88.10 |   100.00 |  100.00 | '), 88.1);
  assert.equal(parseCoverage('All files |   70.5 |  60 |  80 |  71.2 |'), 71.2);
  assert.equal(parseCoverage('Name  Stmts  Miss  Cover\nTOTAL   120   8   93%'), 93);
  assert.equal(parseCoverage('ok  pkg  0.1s  coverage: 87.5% of statements'), 87.5);
  assert.equal(parseCoverage('nothing here'), null);
});

test('judgeCoverage applies min and target', () => {
  assert.equal(judgeCoverage(95, 80, 90), 'ideal');
  assert.equal(judgeCoverage(85, 80, 90), 'acceptable');
  assert.equal(judgeCoverage(79.9, 80, 90), 'low');
});

test('parseTags finds card references but not anchors or self', () => {
  assert.deepEqual(parseTags('Builds on #3 and #12, see [x](#4) and #3', 12), [3]);
  assert.deepEqual(parseTags('color: &#123; issue#9'), []);
});

test('deriveTitle uses the first meaningful line', () => {
  assert.equal(deriveTitle('![img](/u.png)\n\n## Add **login** page\nmore'), 'Add login page');
  assert.equal(deriveTitle(''), 'Untitled task');
});

// ---------------------------------------------------------------- skill links

const { parseGithubUrl, parseSkillsShRef } = await import('../server/skill-import.ts');

test('GitHub and skills.sh links resolve to repositories, folders and skills', () => {
  assert.deepEqual(parseGithubUrl('https://github.com/vercel-labs/skills'), { owner: 'vercel-labs', repo: 'skills', ref: null, subpath: '' });
  assert.deepEqual(parseGithubUrl('https://github.com/acme/tools.git'), { owner: 'acme', repo: 'tools', ref: null, subpath: '' });
  assert.deepEqual(parseGithubUrl('https://github.com/acme/tools/tree/main/skills/release'), { owner: 'acme', repo: 'tools', ref: 'main', subpath: 'skills/release' });
  assert.throws(() => parseGithubUrl('http://github.com/acme/tools'), /Only https:\/\/github.com/);
  assert.throws(() => parseGithubUrl('https://github.com/acme'), /no owner\/repository/);
  assert.throws(() => parseGithubUrl('https://github.com/acme/tools/blob/main/SKILL.md'), /folder with \/tree/);
  assert.deepEqual(parseSkillsShRef('https://skills.sh/vercel-labs/skills/find-skills'), { owner: 'vercel-labs', repo: 'skills', skill: 'find-skills' });
  assert.deepEqual(parseSkillsShRef('mattpocock/skills'), { owner: 'mattpocock', repo: 'skills', skill: null });
  assert.throws(() => parseSkillsShRef('https://skills.sh/site/open.feishu.cn/lark-doc'), /GitHub-hosted/);
  assert.throws(() => parseSkillsShRef('just-one'), /skills.sh link/);
});

// ---------------------------------------------------------------- simulated assistant

const { simulateAssistant } = await import('../server/agents/simulated-assistant.ts');

const board = (id: number, name: string, repoName: string, cards: any[] = []) => ({ id, name, repoName, paused: false, cards });
const PROJECTS = [
  board(1, 'Demo project', 'demo-repo', [
    { id: 4, title: 'Calendar display', stage: 'complete', statusText: '', waitingFor: null, completedAt: 200 },
    { id: 3, title: 'Clamp helper', stage: 'complete', statusText: '', waitingFor: null, completedAt: 100 },
    { id: 7, title: 'Pull invoices', stage: 'deliverables', statusText: 'Waiting for your input', waitingFor: 'input', completedAt: null },
  ]),
  board(2, 'Shop', 'shop-web', [{ id: 9, title: 'Gift wrap', stage: 'icebox', statusText: '', waitingFor: null, completedAt: null }]),
];
let messageId = 0;
const said = (author: 'user' | 'assistant', body: string, cardIds: number[] = []) =>
  ({ id: ++messageId, author, kind: 'message' as const, body, cardIds, details: '', ts: messageId });
/** The assistant's reply to `body`, after any earlier turns. */
const reply = (body: string, earlier: ReturnType<typeof said>[] = [], projects: any[] = PROJECTS) =>
  simulateAssistant({ conversation: [...earlier, said('user', body)], projects, cardDetails: (id) => `#${id} Card\nProject: Demo project\nStage: Complete\nStatus: done` });

test('the simulated assistant drafts cards from everyday phrasing', () => {
  const calendar = reply('in the demo-repo project can you help me create a new task to add calendar settings such as timezone, language ?');
  assert.deepEqual(calendar.actions, [{
    type: 'create_card', projectId: 1, cardId: 0,
    body: '# Add calendar settings such as timezone, language\n\n- timezone\n- language',
  }]);
  const cases: [string, number, string][] = [
    ['Could you please add a dark mode toggle to Shop?', 2, '# Add a dark mode toggle'],
    ['hey, I need you to make a new ticket for the demo project to fix the login redirect', 1, '# Fix the login redirect'],
    ['For shop-web, draft a card about gift receipts', 2, '# Gift receipts'],
    ['Create a card in Shop: # Gift tags\n\n- tag text', 2, '# Gift tags\n\n- tag text'],
  ];
  for (const [message, projectId, body] of cases) {
    const [action] = reply(message).actions;
    assert.deepEqual([action?.type, action?.projectId, action?.body], ['create_card', projectId, body], message);
  }
  // With one project there's nothing to ask; with several it asks, and it never invents a project.
  assert.equal(reply('add a settings page', [], PROJECTS.slice(0, 1)).actions[0].projectId, 1);
  assert.match(reply('add a settings page').reply, /Which project/);
  assert.match(reply('create a task in the billing project to add invoices').reply, /don't see a project called "billing"/);
  assert.match(reply('create a new task in Shop').reply, /What should the card in Shop be about/);
});

test('the simulated assistant acts on the card in context and never on a question or a new task', () => {
  const confirmation = said('assistant', 'Here is how the agents read #9.', [9]);
  const act = (body: string) => reply(body, [confirmation]).actions[0];
  assert.deepEqual(act('looks good, move it to the backlog'), { type: 'move_to_backlog', projectId: 0, cardId: 9, body: '' });
  assert.deepEqual(act('ok queue it'), { type: 'move_to_backlog', projectId: 0, cardId: 9, body: '' });
  assert.deepEqual(act('please approve #7, checked on staging'), { type: 'approve', projectId: 0, cardId: 7, body: 'checked on staging' });
  assert.deepEqual(act('can you tell #7 that the key is in the vault'), { type: 'message_coordinator', projectId: 0, cardId: 7, body: 'the key is in the vault' });
  assert.deepEqual(act('send card 7 back: rename the job'), { type: 'request_changes', projectId: 0, cardId: 7, body: 'rename the job' });
  assert.equal(act('please merge #4 into main')?.type, 'merge');
  assert.deepEqual(act('pull the Shop project'), { type: 'pull', projectId: 2, cardId: 0, body: '' });
  assert.deepEqual(act('can you push demo-repo to github'), { type: 'push', projectId: 1, cardId: 0, body: '' });
  assert.match(reply('pull').reply, /Which project should I pull/);
  assert.deepEqual([act('ok, merge it')?.type, act('ok, merge it')?.cardId], ['merge', 9]);
  assert.equal(act('should I approve #7?'), undefined);
  assert.equal(act('create a task to approve invoices in Shop')?.type, 'create_card');
  assert.match(reply('move it to the backlog').reply, /Which card/);
});

test('the simulated assistant answers status, lists and card questions', () => {
  assert.deepEqual(reply('show me the last card done').cardIds, [4]);
  assert.deepEqual(reply("what's in the Shop icebox?").cardIds, [9]);
  assert.deepEqual(reply('anything for me?').cardIds, [7]);
  assert.match(reply('how is everything going?').reply, /\*\*Demo project\*\*: 1 need you · 2 done\n- \*\*Shop\*\*/);
  assert.match(reply('Shop?').reply, /^- \*\*Shop\*\*: nothing in flight$/);
  assert.deepEqual(reply('tell me more about it', [said('assistant', 'Done.', [4])]).cardIds, [4]);
  assert.match(reply('what is the meaning of life').reply, /simulated assistant[\s\S]*Create a task in Demo project/);
});

test('the API answers only loopback hosts, with a private per-install token', () => {
  for (const host of ['localhost', 'localhost:4400', '127.0.0.1:5173', '[::1]:4400', 'LOCALHOST']) assert.ok(isLoopbackHost(host), host);
  for (const host of [undefined, '', 'evil.example', 'localhost.evil.example', '127.0.0.1.nip.io', '10.0.0.2:4400']) assert.ok(!isLoopbackHost(host), String(host));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-auth-'));
  try {
    const token = loadToken(dir);
    assert.ok(token.length >= 32);
    assert.equal(loadToken(dir), token, 'stable across restarts');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'auth-token')).mode & 0o777, 0o600);
    assert.match(withToken('<html><head><title>x</title></head></html>', token), new RegExp(`<meta name="factory-token" content="${token}" />\\n</head>`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installed CLI versions are compared with the ones the parsers were checked against', async () => {
  const { compareVersion, TESTED_VERSIONS } = await import('../server/providers.ts');
  assert.equal(compareVersion('codex-cli 0.161.0', '0.161.0'), 'tested');
  assert.equal(compareVersion('codex-cli 0.162.0', '0.161.0'), 'newer');
  assert.equal(compareVersion('1.18.9', '1.18.18'), 'older', 'numbers, not strings');
  assert.equal(compareVersion('2.0.0', '1.18.18'), 'newer');
  assert.equal(compareVersion('dev build', '1.0.0'), 'unknown');
  assert.equal(compareVersion(null, '1.0.0'), null);
  assert.equal(compareVersion('2.1.294 (Claude Code)', null), null);
  assert.deepEqual(Object.keys(TESTED_VERSIONS).sort(), ['codex', 'opencode', 'pi'], 'every CLI driver has a tested version');
});

test('pasted MCP server configs fill in a context', async () => {
  const { parseMcpConfig } = await import('../web/src/mcp-config.ts');
  assert.deepEqual(parseMcpConfig(JSON.stringify({ mcpServers: { 'git hub': { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'x' }, cwd: '~/code' } } })), [{
    name: 'git-hub', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], cwd: '~/code', url: '', env: { GITHUB_TOKEN: 'x' }, headers: {},
    bearerTokenEnv: '', envHeaders: {},
  }]);
  assert.deepEqual(parseMcpConfig('{"kb":{"url":"http://127.0.0.1:3003/mcp","bearer_token_env_var":"KB_TOKEN","env_http_headers":{"X-Team":"TEAM_ID"}}}').map((s) => [s.bearerTokenEnv, s.envHeaders]),
    [['KB_TOKEN', { 'X-Team': 'TEAM_ID' }]], "Codex's names for values from the environment");
  assert.deepEqual(parseMcpConfig('{"docs":{"type":"http","url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer t"}}}').map((s) => [s.name, s.transport, s.url, s.headers]),
    [['docs', 'http', 'https://mcp.example.com/mcp', { Authorization: 'Bearer t' }]]);
  assert.equal(parseMcpConfig('{"command":"uvx","args":["mcp-server-fetch"]}')[0].name, '', 'a lone server has no name');
  assert.throws(() => parseMcpConfig('{oops'), /valid JSON/);
  assert.throws(() => parseMcpConfig('{"mcpServers":{}}'), /No MCP server found/);
});

test("each OS's folder dialog command quotes the start folder and title safely", async () => {
  const { dialogCommand } = await import('../server/native-dialog.ts');
  const [mac, macArgs] = dialogCommand('/Users/me/My "odd" folder', 'Pick it', 'darwin')!;
  assert.equal(mac, 'osascript');
  assert.ok(macArgs.includes('set chosen to choose folder with prompt "Pick it" default location (POSIX file "/Users/me/My \\"odd\\" folder")'));
  const [win, winArgs] = dialogCommand("C:\\Users\\O'Neil", 'Pick it', 'win32')!;
  assert.equal(win, 'powershell');
  assert.match(winArgs.at(-1)!, /\$d\.SelectedPath = 'C:\\Users\\O''Neil'/);
  const display = process.env.DISPLAY;
  const wayland = process.env.WAYLAND_DISPLAY;
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  try {
    assert.equal(dialogCommand('/home/me', 'Pick it', 'linux'), null, 'no display, no dialog');
  } finally {
    if (display !== undefined) process.env.DISPLAY = display;
    if (wayland !== undefined) process.env.WAYLAND_DISPLAY = wayland;
  }
});
