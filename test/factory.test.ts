/**
 * End-to-end: drives cards through every stage over the HTTP API using the
 * simulated driver against a throwaway git repo.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import http, { type Server } from 'node:http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-'));
process.env.FACTORY_DATA = dataDir;
process.env.FACTORY_SIM_SPEED = '0';

const db = await import('../server/db.ts');
const { initSettings, updateSettings, defaultSettings, settings: settingsOf } = await import('../server/settings.ts');
const { ensureDemoRepo } = await import('../server/git.ts');
const { Coordinator } = await import('../server/coordinator.ts');
const { Factory } = await import('../server/factory.ts');
const { Assistant } = await import('../server/assistant.ts');
const { createApp } = await import('../server/app.ts');
const { SimulatedDriver } = await import('../server/agents/simulated.ts');
const { subscribe } = await import('../server/events.ts');
const { DevmetricsProcesses } = await import('../server/processes.ts');
const { git } = await import('../server/shell.ts');

let server: Server;
let base: string;
/** The stand-in OS folder dialog: what it was asked, and what it answers next. */
const dialogs: { start: string; title: string }[] = [];
let nextDialog: { path: string | null; supported: true } | { path: null; supported: false } = { path: null, supported: true };
const token = 'test-token-0123456789abcdef0123456789abcdef';
let factory: InstanceType<typeof Factory>;
let assistant: InstanceType<typeof Assistant>;
/** The demo project created on first start. */
const DEMO = 1;
const repo = defaultSettings().repoPath;
const stagesSeen = new Map<number, string[]>();
const processStops: string[] = [];
let managedProcesses = [
  { port: 3018, cwd: repo, summary: 'Demo preview', pid: 12345, startedAt: '2026-10-08T08:00:00Z', stopsOn: '2026-10-08T10:00:00Z', command: 'TOKEN=private-value start-demo' },
  { port: 3019, cwd: `${repo}-other`, summary: 'Unrelated project', pid: 12346, startedAt: '2026-10-08T08:00:00Z' },
];

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-factory-token': token }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text.split('\n').filter(Boolean).at(-1)!) : null, raw: text };
}

// These journeys spawn real git and test processes; busy hosts need time to finish them.
const JOURNEY_WAIT_MS = 90_000;

async function waitFor(cardId: number, pred: (c: any) => boolean, ms = JOURNEY_WAIT_MS) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const card = db.getCard(cardId)!;
    if (pred(card)) return card;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out; card #${cardId} is ${JSON.stringify(db.getCard(cardId))}`);
}

async function until<T>(fn: () => T | null | undefined | false, ms = JOURNEY_WAIT_MS): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out. Assistant said:\n${db.listAssistantMessages(20).map((m) => `${m.kind}: ${m.body}`).join('\n')}`);
}

/** Messages the assistant has posted since `afterId`. */
const assistantSince = (afterId: number) => db.listAssistantMessages(500).filter((m) => m.id > afterId && m.author === 'assistant');
const lastMessageId = () => db.listAssistantMessages(1).at(-1)?.id ?? 0;

/** Sends a message to the assistant and waits for its reply (plus anything `done` asks for). */
async function ask(body: string, done: (messages: ReturnType<typeof assistantSince>) => boolean = () => true) {
  const from = lastMessageId();
  assert.equal((await api('POST', '/api/assistant/messages', { body })).status, 202);
  return until(() => {
    const messages = assistantSince(from);
    return !assistant.busy && messages.some((m) => m.kind === 'message') && done(messages) && messages;
  });
}

/** Creates a card with generated instructions and drags it to the backlog. */
async function queueCard(description: string, projectId = DEMO) {
  const gen = await api('POST', '/api/instructions', { description, projectId });
  assert.equal(gen.body.type, 'done');
  const created = await api('POST', '/api/cards', { projectId, description, instructions: gen.body.instructions, instructionsHash: gen.body.hash });
  assert.equal(created.status, 201);
  assert.equal(created.body.stage, 'icebox');
  const moved = await api('POST', `/api/cards/${created.body.id}/move`, { stage: 'backlog' });
  assert.equal(moved.status, 200, moved.raw);
  return created.body.id as number;
}

before(async () => {
  db.openDb(path.join(dataDir, 'factory.db'));
  initSettings();
  (await import('../server/profiles.ts')).seedProfiles();
  await ensureDemoRepo(repo);
  updateSettings(DEMO, { maxActiveCards: 3, maxWorkers: 3 });
  subscribe((e) => {
    if (e.type !== 'card') return;
    const seen = stagesSeen.get(e.card.id) ?? [];
    if (seen.at(-1) !== e.card.stage) seen.push(e.card.stage);
    stagesSeen.set(e.card.id, seen);
  });
  const driver = new SimulatedDriver();
  factory = new Factory(() => driver);
  assistant = new Assistant(factory, () => driver);
  const processes = new DevmetricsProcesses(() => [repo], async (args) => {
    if (args[0] === 'list') return JSON.stringify(managedProcesses);
    processStops.push(args[1]);
    managedProcesses = managedProcesses.filter((item) => String(item.port) !== args[1]);
    return '';
  });
  server = createApp(factory, assistant, { token, processes, chooseFolder: async (start, title) => { dialogs.push({ start, title }); return nextDialog; } }).listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  factory.start();
  assistant.start();
});

after(async () => {
  await assistant.stop();
  await factory.stop();
  server.close();
  db.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('only this install\'s own page can use the API', async () => {
  const call = (url: string, headers: Record<string, string>, method = 'GET') => fetch(base + url, { method, headers });
  assert.equal((await call('/api/state', {})).status, 401, 'no token');
  assert.equal((await call('/api/state', { 'x-factory-token': 'wrong' })).status, 401);
  assert.equal((await call('/api/state', { 'x-factory-token': token })).status, 200);
  // EventSource can't send headers, so only the event stream takes the token in the URL.
  assert.equal((await call(`/api/state?token=${token}`, {})).status, 401);
  const events = new AbortController();
  const stream = await fetch(`${base}/api/events?token=${token}`, { signal: events.signal });
  assert.equal(stream.status, 200);
  events.abort();
  // DNS rebinding: a site's own name pointing at this machine. (fetch won't send a custom Host.)
  const rebound = await new Promise<number>((resolve, reject) => {
    http.get(`${base}/api/state`, { headers: { 'x-factory-token': token, host: 'evil.example:4400' } }, (res) => { res.resume(); resolve(res.statusCode!); }).on('error', reject);
  });
  assert.equal(rebound, 403);
  // Pages on other sites, even other localhost ports.
  assert.equal((await call('/api/projects', { 'x-factory-token': token, origin: 'https://evil.example' }, 'POST')).status, 403);
  assert.equal((await call('/api/state', { 'x-factory-token': token, origin: 'http://localhost:3999' })).status, 403);
  assert.equal((await call('/api/state', { 'x-factory-token': token, 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await call('/api/state', { 'x-factory-token': token, 'sec-fetch-site': 'same-site' })).status, 403);
  const own = new URL(base).host;
  assert.equal((await call('/api/state', { 'x-factory-token': token, origin: `http://${own}`, 'sec-fetch-site': 'same-origin' })).status, 200);
});

test('cards need current instructions before entering the backlog', async () => {
  const created = await api('POST', '/api/cards', { projectId: DEMO, description: 'No instructions yet' });
  const moved = await api('POST', `/api/cards/${created.body.id}/move`, { stage: 'backlog' });
  assert.equal(moved.status, 409);
  await api('PATCH', `/api/cards/${created.body.id}`, { instructions: '## Objective\nx', instructionsHash: 'some-old-hash' });
  assert.equal((await api('POST', `/api/cards/${created.body.id}/move`, { stage: 'backlog' })).status, 409);
  const skip = await api('POST', `/api/cards/${created.body.id}/move`, { stage: 'complete' });
  assert.equal(skip.status, 409);
});

test('a routine card flows through every stage, looping once on audit feedback', async () => {
  const id = await queueCard('# Add subtract helper\n\n- subtract(a, b) in src/math.js\n- tests for subtract');
  const card = await waitFor(id, (c) => c.stage === 'complete' && c.worktree === null);
  assert.deepEqual(stagesSeen.get(id), ['icebox', 'backlog', 'in_progress', 'verification', 'in_progress', 'verification', 'acceptance', 'complete']);
  assert.equal(card.loops, 1);
  assert.equal(card.coverage, 100, db.listLogs(id).filter((l) => /overage/.test(l.text)).map((l) => l.text).join('\n'));
  assert.equal(card.worktree, null);

  const subs = db.listSubtasks(id);
  assert.deepEqual(subs.map((s) => s.kind), ['build', 'build', 'fix', 'acceptance']);
  assert.ok(subs.every((s) => s.status === 'done'));
  assert.ok(subs[0].diff.includes('subtract'));

  const files = await git(repo, 'ls-tree', '-r', '--name-only', `factory/card-${id}`);
  assert.match(files, new RegExp(`acceptance/card-${id}/`));
  assert.match(files, new RegExp(`factory-sim/card-${id}/`));
  const levels = new Set(db.listLogs(id).map((l) => l.level));
  assert.deepEqual([...levels].sort(), ['detail', 'diff', 'oneliner', 'summary']);
  const detail = (await api('GET', `/api/cards/${id}`)).body;
  assert.match(detail.deliveryNotes, /How to review/);
  assert.match(detail.deliveryNotes, /no preview URL recorded/);
  assert.match(detail.deliveryNotes, /no test account recorded/);
  assert.match(detail.deliveryNotes, /Acceptance tests passed/);
  assert.ok(detail.comments.some((comment: any) => comment.kind === 'handoff'));
});

test('a card needing a credential waits in Deliverables, resumes with it, then needs approval', async () => {
  const id = await queueCard('# Sync orders from the Acme API\n\nUse the ACME_API_KEY to pull orders nightly and store them.');
  await waitFor(id, (c) => c.stage === 'deliverables' && c.deliverableKind === 'input');
  assert.ok(db.listSubtasks(id).some((s) => s.status === 'blocked'));
  assert.match(db.listComments(id).map((c) => c.body).join('\n'), /ACME_API_KEY/);

  // Unclear input gets pushed back, not acted on.
  await api('POST', `/api/cards/${id}/comment`, { body: 'hmm' });
  await waitFor(id, () => db.listComments(id).at(-1)?.author === 'coordinator');
  assert.equal(db.getCard(id)!.stage, 'deliverables');

  // Asking about continuing is a question, not permission to start work.
  const commentsBeforeQuestion = db.listComments(id).length;
  await api('POST', `/api/cards/${id}/comment`, { body: 'How can I resume this work?' });
  await waitFor(id, () => db.listComments(id).length > commentsBeforeQuestion + 1 && !factory.forCard(id).isChatBusy(id));
  assert.equal(db.getCard(id)!.stage, 'deliverables');
  assert.equal(db.getCard(id)!.deliverableKind, 'input');

  await api('POST', `/api/cards/${id}/comment`, { body: 'Here is the key you asked for', secrets: { ACME_API_KEY: 'sk-test' } });
  await waitFor(id, (c) => c.stage === 'deliverables' && c.deliverableKind === 'approval');
  assert.deepEqual(db.getCard(id)!.secretNames, ['ACME_API_KEY']);

  const approved = await api('POST', `/api/cards/${id}/approve`, { note: 'Checked against staging' });
  assert.equal(approved.body.stage, 'complete');
});

test('aborting a running card stops it and returns it to the Icebox', async () => {
  updateSettings(DEMO, { paused: true });
  const id = await queueCard('# Long task\n\n- step one\n- step two\n- step three');
  updateSettings(DEMO, { paused: false });
  factory.coordinator(DEMO).tick();
  await waitFor(id, (c) => c.stage === 'in_progress' || c.stage === 'verification');
  const res = await api('POST', `/api/cards/${id}/abort`);
  assert.equal(res.body.stage, 'icebox');
  assert.equal(res.body.branch, null);
  const branches = await git(repo, 'branch', '--list', `factory/card-${id}*`);
  assert.equal(branches, '');
  assert.match(await git(repo, 'branch', '--list', `factory/archive/card-${id}-*`), /archive/);
  assert.ok(db.listSubtasks(id).every((s) => s.status === 'done' || s.status === 'aborted'), JSON.stringify(db.listSubtasks(id).map((s) => s.status)));
  // Editable again.
  assert.equal((await api('PATCH', `/api/cards/${id}`, { description: '# Long task v2' })).status, 200);
});

test('Icebox cards can be edited; active cards cannot', async () => {
  const id = await queueCard('# Tiny\n\n- one\n- two');
  const res = await api('PATCH', `/api/cards/${id}`, { description: 'changed' });
  assert.equal(res.status, 409);
  await waitFor(id, (c) => c.stage === 'complete');
});

test('completed-card chat answers questions and drafts clear development work only in the Icebox', async () => {
  const card = db.listCards().find((item) => item.stage === 'complete')!;
  const before = db.listCards().length;
  const status = card.status;
  const message = async (body: string) => {
    const count = db.listComments(card.id).length;
    assert.equal((await api('POST', `/api/cards/${card.id}/comment`, { body })).status, 202);
    await waitFor(card.id, () => db.listComments(card.id).length > count + 1 && !factory.forCard(card.id).isChatBusy(card.id));
    return db.listComments(card.id).at(-1)!;
  };
  assert.match((await message('How can I review these changes?')).body, /How to review/);
  assert.equal(db.listCards().length, before);
  assert.equal(db.getCard(card.id)!.stage, 'complete');
  assert.equal(db.getCard(card.id)!.status, status);

  assert.match((await message('Maybe improve it somehow')).body, /specific change/);
  assert.equal(db.listCards().length, before);
  const reply = await message('Can you add a timezone selector to the calendar settings?');
  const draft = db.listCards().find((item) => item.parentId === card.id && /timezone selector/.test(item.description))!;
  assert.ok(draft);
  assert.equal(draft.stage, 'icebox');
  assert.equal(draft.instructions, '');
  assert.equal(draft.parentId, card.id);
  assert.match(reply.body, new RegExp(`Created #${draft.id} in the`));
  assert.deepEqual(stagesSeen.get(draft.id), ['icebox']);
  assert.equal((await api('POST', `/api/cards/${draft.id}/move`, { stage: 'backlog' })).status, 409);
});

test('coordinator chat leaves an active card status alone and is cancelled on abort', async () => {
  const driver = new SimulatedDriver();
  const waiting = new Coordinator(DEMO, () => driver);
  const created = db.createCard({ projectId: DEMO, description: '# Chat while queued', instructions: 'Do this', instructionsHash: null });
  db.moveCard(created.id, 'backlog');
  db.setStatus(created.id, 'queued', 'Waiting to start');
  waiting.comment(created.id, 'What is the current status?', {});
  assert.equal(db.getCard(created.id)!.status, 'queued');
  await waiting.abort(created.id);
  assert.equal(db.getCard(created.id)!.stage, 'icebox');
  assert.equal(db.listComments(created.id).filter((item) => item.author === 'coordinator').length, 0);
  assert.equal(waiting.isChatBusy(created.id), false);
  await waiting.stop();
});

test('legacy cards get recorded review details and secrets are redacted from chat', async () => {
  const created = db.createCard({ projectId: DEMO, description: '# Legacy result', instructions: '', instructionsHash: null });
  db.moveCard(created.id, 'complete');
  db.setSecrets(created.id, { LEGACY_TOKEN: 'synthetic-private-value' });
  const detail = (await api('GET', `/api/cards/${created.id}`)).body;
  assert.match(detail.deliveryNotes, /no preview URL recorded/);
  assert.match(detail.deliveryNotes, /No passing verification results recorded/);
  await api('POST', `/api/cards/${created.id}/comment`, { body: 'What does synthetic-private-value mean here?' });
  await waitFor(created.id, () => !factory.forCard(created.id).isChatBusy(created.id));
  assert.ok(!JSON.stringify(db.listComments(created.id)).includes('synthetic-private-value'));
  assert.equal((await api('POST', `/api/cards/${created.id}/comment`, { body: 'Here is a secret', secrets: { API_KEY: 'synthetic-key' } })).status, 409);
});

test('process inventory and stopping are project-scoped and reject stale identities', async () => {
  const listing = await api('GET', '/api/processes');
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.body.processes.map((item: any) => item.summary), ['Demo preview']);
  assert.ok(!listing.raw.includes('private-value'));
  const id = listing.body.processes[0].id;
  assert.equal((await api('POST', '/api/processes/stop', { id: '3019:2026-10-08T08:00:00Z' })).status, 404);
  assert.equal((await api('POST', '/api/processes/stop', { id: 12345 })).status, 400);
  assert.equal((await api('POST', '/api/processes/stop', { id: '3018:old-start-time' })).status, 404);
  assert.deepEqual(processStops, []);
  assert.equal((await api('POST', '/api/processes/stop', { id })).status, 200);
  assert.deepEqual(processStops, ['3018']);
  assert.deepEqual((await api('GET', '/api/processes')).body.processes, []);
});

// ---------------------------------------------------------------- projects and the assistant

const otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-shop-'));
let shop: number;

test('projects keep their own boards, settings and coordinators', async () => {
  await ensureDemoRepo(otherRepo);
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-plain-'));
  assert.equal((await api('POST', '/api/projects', { name: 'Shop', settings: { repoPath: '' } })).status, 400);
  assert.equal((await api('POST', '/api/projects', { name: 'Shop', settings: { repoPath: notRepo } })).status, 400);
  assert.equal((await api('POST', '/api/projects', { name: 'Again', settings: { repoPath: repo } })).status, 409);
  assert.equal((await api('POST', '/api/projects', { name: ' ', settings: { repoPath: otherRepo } })).status, 400);
  const created = await api('POST', '/api/projects', { name: 'Shop', settings: { repoPath: otherRepo, paused: true, unknownKey: 1 } });
  assert.equal(created.status, 201, created.raw);
  shop = created.body.id;
  assert.equal(created.body.settings.paused, true);
  assert.equal(created.body.settings.unknownKey, undefined);
  assert.equal((await api('PATCH', `/api/projects/${shop}`, { settings: { repoPath: repo } })).status, 409);

  const state = (await api('GET', '/api/state')).body;
  assert.deepEqual(state.projects.map((p: any) => p.name), ['Demo project', 'Shop']);
  assert.equal(state.projects[0].settings.paused, false);

  // A paused project holds its backlog while the other keeps running.
  const id = await queueCard('# Shop banner\n\n- banner text\n- banner tests', shop);
  assert.equal(db.getCard(id)!.projectId, shop);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(db.getCard(id)!.stage, 'backlog');
  assert.throws(() => factory.coordinator(DEMO).enqueue(id), /not found/);
  assert.equal((await api('PATCH', `/api/projects/${shop}`, { name: 'Shop', settings: { paused: false } })).status, 200);
  await waitFor(id, (c) => c.stage === 'complete' && c.worktree === null);
  assert.match(await git(otherRepo, 'branch', '--list', `factory/card-${id}`), /card/);
  assert.equal(await git(repo, 'branch', '--list', `factory/card-${id}`), '');
});

test('the assistant reports status, drafts cards for confirmation and queues them only when asked', async () => {
  const status = await ask('What is the status of all projects?');
  assert.match(status.at(-1)!.body, /\*\*Demo project\*\*/);
  assert.match(status.at(-1)!.body, /\*\*Shop\*\*: 1 done/);

  const cardsBefore = db.listCards().length;
  assert.match((await ask('Create a card: a loyalty program')).at(-1)!.body, /Which project/);
  assert.equal(db.listCards().length, cardsBefore);

  const drafted = await ask('Create a card in Shop: # Gift wrap option\n\n- wrap toggle\n- wrap fee', (messages) => messages.some((m) => m.details));
  const card = db.listCards(shop).find((c) => c.title === 'Gift wrap option')!;
  assert.equal(card.stage, 'icebox');
  assert.ok(card.instructionsCurrent);
  assert.match(drafted.find((m) => m.kind === 'action')!.body, new RegExp(`Drafted #${card.id} in the \\*\\*Shop\\*\\* Icebox`));
  const confirmation = drafted.find((m) => m.details)!;
  assert.deepEqual(confirmation.cardIds, [card.id]);
  assert.equal(confirmation.details, card.instructions);
  assert.match(confirmation.body, /\*\*Objective\*\*[\s\S]*move it to the Backlog/);

  // Actions are validated like the board's own controls.
  const refused = await ask(`Approve #${card.id}`, (messages) => messages.some((m) => m.kind === 'error'));
  assert.match(refused.find((m) => m.kind === 'error')!.body, /isn't waiting in Deliverables/);
  assert.deepEqual(stagesSeen.get(card.id), ['icebox']);

  await ask(`Move #${card.id} to the backlog`, (messages) => messages.some((m) => m.kind === 'action'));
  await waitFor(card.id, (c) => c.stage === 'complete' && c.worktree === null);
  const done = await until(() => db.listAssistantMessages(500).find((m) => m.kind === 'notification' && m.cardIds[0] === card.id));
  assert.match(done.body, new RegExp(`is complete in \\*\\*Shop\\*\\*\\. Not merged yet; the work is on \`factory/card-${card.id}\`\\. That was the last one: everything in \\*\\*Shop\\*\\* is done\\.`));

  // Asking to see cards answers with clickable previews.
  const last = (await ask('Show me the last card done')).at(-1)!;
  assert.deepEqual(last.cardIds, [card.id]);
  assert.match(last.body, new RegExp(`#${card.id} Gift wrap option`));
  const shopDone = (await ask('List the completed cards in Shop')).at(-1)!;
  assert.deepEqual(shopDone.cardIds.sort(), db.listCards(shop).filter((c) => c.stage === 'complete').map((c) => c.id).sort());
});

test('the assistant passes on deliverables, relays coordinator replies and resolves cards when asked', async () => {
  const id = await queueCard('# Pull invoices from Billing\n\nUse the BILLING_API_KEY to pull invoices every night.');
  await waitFor(id, (c) => c.stage === 'deliverables' && c.deliverableKind === 'input');
  const needed = await until(() => db.listAssistantMessages(500).find((m) => m.kind === 'notification' && m.cardIds[0] === id));
  assert.match(needed.body, /needs your input/);
  assert.match(needed.body, /BILLING_API_KEY/);
  const needs = (await ask('What needs me?')).at(-1)!;
  assert.ok(needs.cardIds.includes(id));
  assert.match(needs.body, new RegExp(`#${id} \\(input\\)`));

  await ask(`Tell #${id} how should I provide the key?`, (messages) => messages.some((m) => m.kind === 'relay'));
  const asked = db.listComments(id).find((c) => c.author === 'user' && c.via === 'assistant')!;
  assert.equal(asked.body, 'how should I provide the key?');
  assert.equal(db.getCard(id)!.stage, 'deliverables');

  // Secrets never go through the assistant; the card's own Secret field provides them.
  await api('POST', `/api/cards/${id}/comment`, { body: 'Here is the key you asked for', secrets: { BILLING_API_KEY: 'sk-billing' } });
  await waitFor(id, (c) => c.stage === 'deliverables' && c.deliverableKind === 'approval');
  await until(() => db.listAssistantMessages(500).find((m) => m.kind === 'notification' && m.cardIds[0] === id && /ready for your approval/.test(m.body)));

  const wrongControl = await ask(`Resume #${id}`, (messages) => messages.some((m) => m.kind === 'error'));
  assert.match(wrongControl.find((m) => m.kind === 'error')!.body, /waiting for approval, not input/);
  await ask(`Approve #${id} verified on staging`, (messages) => messages.some((m) => m.kind === 'action'));
  assert.equal(db.getCard(id)!.stage, 'complete');
  const approval = db.listComments(id).find((c) => c.kind === 'approval')!;
  assert.deepEqual([approval.body, approval.via], ['verified on staging', 'assistant']);
  assert.ok(!JSON.stringify(db.listAssistantMessages(500)).includes('sk-billing'));
});

/** Commits a file on the demo repo's main checkout, moving main. */
async function commitOnMain(file: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
  await git(repo, 'add', '-A');
  await git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', `Change ${file} on main`);
}
const notices = (id: number) => db.listAssistantMessages(500).filter((m) => m.kind === 'notification' && m.cardIds[0] === id);
/** The merge card queued for a finished card. */
const mergeCardFor = (id: number) => until(() => db.listCards().find((c) => c.kind === 'merge' && c.parentId === id));

test('completed cards record whether their branch reached the base branch', async () => {
  const { isAncestor } = await import('../server/git.ts');

  // Kept by default; a merge made by hand afterwards is noticed.
  const kept = db.listCards(DEMO).find((c) => c.kind === 'task' && c.stage === 'complete' && c.branch && c.mergeState === 'unmerged')!;
  assert.equal(kept.mergeNote, `Kept on factory/card-${kept.id}`);
  await git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'merge', '--no-ff', '-m', 'Manual merge', `factory/card-${kept.id}`);
  await factory.coordinator(DEMO).refreshMergeStates();
  assert.deepEqual([db.getCard(kept.id)!.mergeState, db.getCard(kept.id)!.mergeNote], ['merged', 'Merged into main']);

  updateSettings(DEMO, { onComplete: 'merge' });
  const scratch = path.join(repo, 'scratch.txt');
  try {
    // Projects that merge completed work queue a merge card for it.
    const merged = await queueCard('# Merge me\n\n- merge one\n- merge two');
    await waitFor(merged, (c) => c.stage === 'complete' && c.worktree === null);
    const auto = await mergeCardFor(merged);
    assert.match(db.listLogs(auto.id).map((l) => l.text).join('\n'), /the project merges completed work automatically/);
    assert.equal((await waitFor(merged, (c) => c.mergeState === 'merged')).mergeNote, `Merged into main by #${auto.id}`);
    assert.equal(await isAncestor(repo, `factory/card-${merged}`, 'main'), true);
    assert.match((await until(() => notices(merged).find((m) => /Merged into main/.test(m.body)))).body, new RegExp(`in \\*\\*Demo project\\*\\*: Merged into main by #${auto.id}\\.`));

    // A dirty main checkout is never touched: the merge card waits for the user, then resumes.
    fs.writeFileSync(scratch, 'work in progress');
    const blocked = await queueCard('# Blocked merge\n\n- block one\n- block two');
    await waitFor(blocked, (c) => c.stage === 'complete' && c.worktree === null);
    const waiting = await waitFor((await mergeCardFor(blocked)).id, (c) => c.stage === 'deliverables');
    assert.equal(waiting.statusText, "Can't land: main checkout has uncommitted changes");
    assert.deepEqual([db.getCard(blocked)!.merging, db.getCard(blocked)!.mergeNote], [true, `Merge #${waiting.id} is blocked: main checkout has uncommitted changes`]);
    assert.match((await until(() => notices(waiting.id).find((m) => /needs your help/.test(m.body)))).body, /uncommitted changes/);
    fs.rmSync(scratch);
    assert.equal((await api('POST', `/api/cards/${waiting.id}/resume`, {})).status, 200);
    assert.equal((await waitFor(blocked, (c) => c.mergeState === 'merged')).merging, false);
  } finally {
    fs.rmSync(scratch, { force: true });
    updateSettings(DEMO, { onComplete: 'keep' });
  }
});

test('merge cards land verified code, re-verifying it when main has moved', async () => {
  const { isAncestor } = await import('../server/git.ts');
  const landed = (id: number) => waitFor(id, (c) => c.mergeState === 'merged' && !c.merging);

  // main hasn't moved since the card branched: the merge card lands straight from the Backlog.
  const fast = await queueCard('# Fast merge\n\n- fast one\n- fast two');
  await waitFor(fast, (c) => c.stage === 'complete' && c.worktree === null);
  const sourceStages = stagesSeen.get(fast)!.length;
  const queued = await api('POST', `/api/cards/${fast}/merge`);
  assert.equal(queued.status, 200, queued.raw);
  assert.deepEqual([queued.body.kind, queued.body.parentId, queued.body.branch], ['merge', fast, `factory/card-${fast}`]);
  await landed(fast);
  assert.equal(stagesSeen.get(fast)!.length, sourceStages, 'the finished card stays in Complete');
  assert.deepEqual(stagesSeen.get(queued.body.id), ['backlog', 'complete']);
  assert.equal(await isAncestor(repo, `factory/card-${fast}`, 'main'), true);
  assert.equal((await api('POST', `/api/cards/${fast}/merge`)).status, 409);
  assert.equal((await api('POST', `/api/cards/${queued.body.id}/move`, { stage: 'icebox' })).status, 409);

  // main moved and conflicts: a worker resolves it on the merge card, which is verified before main moves.
  const clash = await queueCard('# Conflicting merge\n\n- clash one\n- clash two');
  await waitFor(clash, (c) => c.stage === 'complete' && c.worktree === null);
  const file = db.listSubtasks(clash).flatMap((s) => s.files).find((f) => f.path.startsWith('factory-sim/'))!.path;
  const cardVersion = await git(repo, 'show', `factory/card-${clash}:${file}`);
  await commitOnMain(file, 'the main branch version\n');
  await ask(`merge #${clash}`, (messages) => messages.some((m) => m.kind === 'action'));
  const merge = await mergeCardFor(clash);
  await landed(clash);
  assert.deepEqual(stagesSeen.get(merge.id), ['backlog', 'in_progress', 'verification', 'acceptance', 'complete']);
  const resolution = db.listSubtasks(merge.id).find((s) => s.kind === 'merge')!;
  assert.deepEqual([resolution.title, resolution.status], ['Resolve conflicts with main', 'done']);
  assert.equal(await git(repo, 'show', `main:${file}`), cardVersion);
  assert.equal(db.getCard(clash)!.mergeNote, `Merged into main by #${merge.id}`);
  await until(() => notices(clash).find((m) => /Merged into main/.test(m.body)));
  assert.equal(notices(merge.id).length, 0, 'a merge card reports on the card it merged');

  // The merge can be audited: who asked, every stage change with its reason, and each git command with its SHAs.
  const trail = db.listLogs(merge.id).filter((l) => l.actor === 'coordinator' && l.level === 'summary').map((l) => l.text);
  const has = (re: RegExp) => assert.ok(trail.some((t) => re.test(t)), `${re}\n${trail.join('\n')}`);
  has(new RegExp(`^Queued to merge #${clash} \\(factory/card-${clash}\\) into main: you asked, through the assistant\\.$`));
  has(/^main has moved since factory\/card-\d+ was verified, so it is merged in/);
  has(/^\*\*Backlog → In Progress\*\*: main conflicts with factory\/card-\d+ in `factory-sim\/[^`]+` \(attempt 1\/5\); a worker resolves them$/);
  has(/^\*\*In Progress → Verification\*\*: all subtasks merged into the card branch$/);
  has(/^\*\*Verification → Acceptance\*\*: tests passed$/);
  has(/^\*\*Acceptance → Complete\*\*: merged into main$/);
  has(/^Merged factory\/card-\d+ into main\./);
  const details = db.listLogs(merge.id).filter((l) => l.level === 'detail').map((l) => l.text).join('\n');
  assert.match(details, /\$ git merge-base --is-ancestor main factory\/card-\d+ {2}# main is not in factory\/card-\d+/);
  assert.match(details, /\$ git merge --no-ff main\n[\s\S]*CONFLICT[\s\S]*\$ git merge --abort/);
  assert.match(details, /# main: \w{7} → \w{7}/);
  assert.match(db.listLogs(clash).map((l) => l.text).join('\n'), new RegExp(`Queued #${merge.id} to merge`));

  // Cancelling a merge card leaves the finished card complete, on its branch, not archived.
  const stop = await queueCard('# Cancelled merge\n\n- stop one\n- stop two');
  await waitFor(stop, (c) => c.stage === 'complete' && c.worktree === null);
  await commitOnMain(`notes/moved-${stop}.md`, 'main moves on\n');
  const cancelMe = (await api('POST', `/api/cards/${stop}/merge`)).body;
  await waitFor(cancelMe.id, (c) => ['in_progress', 'verification', 'acceptance'].includes(c.stage));
  const cancelled = (await api('POST', `/api/cards/${cancelMe.id}/abort`)).body;
  assert.deepEqual([cancelled.stage, cancelled.statusText], ['complete', 'Cancelled']);
  const source = db.getCard(stop)!;
  assert.deepEqual([source.merging, source.mergeState, source.mergeNote], [false, 'unmerged', `Merge #${cancelMe.id} cancelled; kept on factory/card-${stop}`]);
  assert.match(await git(repo, 'branch', '--list', `factory/card-${stop}`), /card/);
  assert.match((await until(() => notices(stop).find((m) => /cancelled/.test(m.body)))).body, /work stays on `factory\/card-\d+`/);
});

test('agent profiles carry briefs and skills, teams decide who works where, and usage is recorded', async () => {
  const state = (await api('GET', '/api/state')).body;
  const byName = (name: string) => state.profiles.find((p: any) => p.name === name);
  assert.deepEqual(state.profiles.map((p: any) => p.name), ['Grace Hopper', 'Linus Torvalds', 'Alex', 'Jamie', 'Sam', 'Casey', 'Riley', 'Ada Lovelace']);

  const SKILL = '---\nname: release-notes\ndescription: Write release notes for every change.\n---\n# Release notes\n\nList user-facing changes.';
  const skill = await api('POST', '/api/skills', { content: SKILL });
  assert.equal(skill.status, 201, skill.raw);
  assert.equal(skill.body.description, 'Write release notes for every change.');
  assert.equal((await api('POST', '/api/skills', { content: SKILL })).status, 409);
  assert.equal((await api('POST', '/api/skills', { content: '# no frontmatter' })).status, 400);
  assert.equal((await api('GET', `/api/skills/${skill.body.id}`)).body.content, SKILL);

  // Unknown skills and images from elsewhere are dropped.
  const created = await api('POST', '/api/profiles', {
    name: 'Margaret Hamilton', job: 'developer', title: '  Flight Software Engineer ', context: 'Write defensive code.',
    skillIds: [skill.body.id, 9999], imageUrl: 'https://evil.example/x.png',
  });
  assert.equal(created.status, 201, created.raw);
  const margaret = created.body;
  assert.deepEqual([margaret.skillIds, margaret.imageUrl, margaret.title], [[skill.body.id], null, 'Flight Software Engineer']);
  assert.equal(byName('Alex').title, '', 'default titles show the role');
  assert.deepEqual([byName('Casey').job, byName('Casey').title], ['developer', 'Designer']);
  const plugin = path.join(dataDir, 'profiles', String(margaret.id));
  assert.equal(fs.readFileSync(path.join(plugin, 'skills', 'release-notes', 'SKILL.md'), 'utf8'), SKILL);
  assert.match(fs.readFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'), /factory-profile-/);

  // Shop's team: Grace coordinates, Linus reviews, Margaret and Casey (titled Designer) work; there's no auditor.
  const team = [byName('Grace Hopper').id, byName('Linus Torvalds').id, margaret.id, byName('Casey').id];
  assert.equal((await api('PATCH', `/api/projects/${shop}`, { settings: { team: [...team, 9999] } })).body.settings.team.join(), team.join());
  const id = await queueCard('# Shop receipts\n\n- design the receipt layout\n- receipt totals', shop);
  await waitFor(id, (c) => c.stage === 'complete' && c.worktree === null);
  const subtasks = db.listSubtasks(id);
  const workers = [margaret.id, byName('Casey').id];
  assert.ok(subtasks.every((s) => workers.includes(s.profileId!)), JSON.stringify(subtasks.map((s) => s.profileId)));
  assert.equal(subtasks.find((s) => s.title === 'design the receipt layout')!.profileId, byName('Casey').id, 'design work goes to a worker titled for it');
  assert.equal(subtasks.find((s) => s.title === 'receipt totals')!.profileId, margaret.id, 'the rest goes to the least busy worker');
  const logs = db.listLogs(id);
  assert.ok(logs.some((l) => l.profileId === margaret.id && l.text === 'Using skills: release-notes'));
  assert.ok(logs.filter((l) => l.actor === 'coordinator').every((l) => l.profileId === byName('Grace Hopper').id || l.profileId === null));
  assert.ok(logs.filter((l) => l.actor === 'senior').every((l) => l.profileId === byName('Linus Torvalds').id));

  // Every run is charged to its project, card and profile; the assistant's too.
  const usage = (await api('GET', `/api/cards/${id}`)).body.usage;
  assert.ok(usage.runs >= subtasks.length && usage.inputTokens > 0 && usage.costUsd === 0, JSON.stringify(usage));
  const margaretsRuns = subtasks.filter((s) => s.profileId === margaret.id).length;
  assert.ok(margaretsRuns > 0 && (await api('GET', `/api/projects/${shop}/usage`)).body.byProfile[margaret.id].runs >= margaretsRuns);
  assert.ok((await api('GET', '/api/state')).body.usage.byProfile[byName('Ada Lovelace').id].runs > 0);

  // Jobs projects rely on can't be left empty; removing a profile takes it off teams.
  assert.equal((await api('DELETE', `/api/profiles/${byName('Grace Hopper').id}`)).status, 409);
  const lastArchitect = await api('PATCH', `/api/profiles/${byName('Linus Torvalds').id}`, { job: 'developer' });
  assert.deepEqual([lastArchitect.status, lastArchitect.body.error], [409, 'Linus Torvalds is the only architect; add another first']);
  // The assistant is one agent: it can't be deleted, keeps its role, and nobody else takes it.
  const ada = byName('Ada Lovelace');
  const deleteAda = await api('DELETE', `/api/profiles/${ada.id}`);
  assert.deepEqual([deleteAda.status, deleteAda.body.error], [409, "Ada Lovelace is the Chief of Staff, who runs the assistant, and can't be deleted"]);
  assert.equal((await api('PATCH', `/api/profiles/${ada.id}`, { job: 'developer' })).status, 409);
  const secondChief = await api('POST', '/api/profiles', { name: 'Second Chief', job: 'assistant' });
  assert.deepEqual([secondChief.status, secondChief.body.error], [409, "There's only one Chief of Staff: Ada Lovelace"]);
  assert.equal((await api('PATCH', `/api/profiles/${margaret.id}`, { job: 'assistant' })).status, 409);
  assert.equal((await api('PATCH', `/api/profiles/${ada.id}`, { title: 'Chief of Staff' })).status, 200, 'everything else about Ada can change');
  assert.equal((await api('DELETE', `/api/profiles/${margaret.id}`)).status, 204);
  const after = (await api('GET', '/api/state')).body;
  assert.deepEqual(after.projects.find((p: any) => p.id === shop).settings.team, team.filter((p) => p !== margaret.id));
  assert.equal(after.profiles.find((p: any) => p.id === margaret.id).archived, true, 'archived, so past activity keeps the name');
  assert.equal((await api('PATCH', `/api/profiles/${margaret.id}`, { name: 'Back again' })).status, 404);
  assert.equal(fs.existsSync(plugin), false);
  assert.equal((await api('DELETE', `/api/skills/${skill.body.id}`)).status, 204);
  updateSettings(shop, { team: [] });
});

test('the skills library imports whole skill folders from a folder, GitHub and skills.sh', async () => {
  const { importFromGit } = await import('../server/skill-import.ts');
  const b64 = (text: string) => Buffer.from(text).toString('base64');
  const md = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill.\n---\n# ${name}\n`;

  // A folder picked in the browser: each skill folder with its files; bad ones are reported, not fatal.
  const folder = (await api('POST', '/api/skills/import/folder', {
    source: 'my-skills',
    skills: [
      { where: 'skills/alpha', files: [{ path: 'SKILL.md', data: b64(md('alpha')) }, { path: 'scripts/run.sh', data: b64('echo hi\n') }] },
      { where: 'escape', files: [{ path: 'SKILL.md', data: b64(md('escape')) }, { path: '../outside.txt', data: b64('x') }] },
      { where: 'nameless', files: [{ path: 'skill.md', data: b64('# No frontmatter') }] },
    ],
  })).body;
  assert.deepEqual(folder.added, ['alpha']);
  assert.deepEqual(folder.skipped.map((s: any) => s.where), ['escape', 'nameless']);
  assert.match(folder.skipped[0].reason, /Unsafe path/);
  assert.match(folder.skipped[1].reason, /needs frontmatter with a name/);
  const alpha = db.listSkills().find((s) => s.name === 'alpha')!;
  assert.deepEqual([alpha.source, alpha.fileCount], ['Folder: my-skills', 2]);
  assert.deepEqual((await api('GET', `/api/skills/${alpha.id}`)).body.files, ['SKILL.md', 'scripts/run.sh']);
  const again = (await api('POST', '/api/skills/import/folder', { source: 'my-skills', skills: [{ where: '', files: [{ path: 'SKILL.md', data: b64(md('alpha')) }] }] })).body;
  assert.deepEqual([again.added, again.updated], [[], ['alpha']]);
  assert.equal(db.getSkill(alpha.id)!.fileCount, 1, 're-importing replaces the folder');

  // Attached skills reach the agent with all their files.
  await api('POST', '/api/skills/import/folder', { source: 'my-skills', skills: [{ where: '', files: [{ path: 'SKILL.md', data: b64(md('alpha')) }, { path: 'scripts/run.sh', data: b64('echo hi\n') }] }] });
  const riley = db.listProfiles().find((p) => p.name === 'Riley')!;
  await api('PATCH', `/api/profiles/${riley.id}`, { skillIds: [alpha.id] });
  assert.equal(fs.readFileSync(path.join(dataDir, 'profiles', String(riley.id), 'skills', 'alpha', 'scripts', 'run.sh'), 'utf8'), 'echo hi\n');

  // Links are checked before anything is cloned.
  assert.equal((await api('POST', '/api/skills/import/github', { url: 'https://gitlab.com/owner/repo' })).status, 400);
  assert.match((await api('POST', '/api/skills/import/skills-sh', { ref: 'https://skills.sh/site/open.feishu.cn/lark-doc' })).body.error, /GitHub-hosted/);

  // Repositories (local here): a skills folder wins over stray SKILL.md files; skills.sh names one skill.
  const commitRepo = async (files: Record<string, string>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-skillrepo-'));
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    await git(dir, 'init', '-q', '-b', 'main');
    await git(dir, 'add', '-A');
    await git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-q', '-m', 'Skills');
    return dir;
  };
  const multi = await commitRepo({ 'skills/beta/SKILL.md': md('beta'), 'skills/beta/reference.md': 'notes', 'skills/gamma/SKILL.md': md('gamma'), '.factory/x/SKILL.md': md('stray'), 'README.md': '# repo' });
  const single = await commitRepo({ 'SKILL.md': md('delta'), 'templates/note.md': 'template' });
  try {
    assert.deepEqual((await importFromGit(multi, { source: 'GitHub: test/multi' })).added.sort(), ['beta', 'gamma']);
    assert.equal(db.listSkills().some((s) => s.name === 'stray'), false);
    assert.equal(db.listSkills().find((s) => s.name === 'beta')!.fileCount, 2);
    const one = await importFromGit(multi, { skill: 'gamma', source: 'skills.sh: test/multi/gamma' });
    assert.deepEqual([one.added, one.updated], [[], ['gamma']]);
    await assert.rejects(importFromGit(multi, { skill: 'missing', source: 'skills.sh: test/multi/missing' }), /No skill called "missing"/);
    assert.deepEqual((await importFromGit(single, { source: 'GitHub: test/single' })).added, ['delta']);
    assert.equal(db.listSkills().find((s) => s.name === 'delta')!.fileCount, 2);
  } finally {
    fs.rmSync(multi, { recursive: true, force: true });
    fs.rmSync(single, { recursive: true, force: true });
  }
});

test('providers must be installed to switch on and switched on to choose', async () => {
  // Nothing is detected in tests, so every CLI counts as not installed; Claude starts switched on.
  const providers = (await api('GET', '/api/state')).body.providers;
  assert.deepEqual(providers.map((p: any) => [p.id, p.enabled, p.runsWork]), [['claude', true, true], ['codex', false, true], ['opencode', false, true], ['pi', false, true]]);
  assert.ok(providers.find((p: any) => p.id === 'claude').models.includes('claude-opus-5-5'));

  const turnOn = await api('PATCH', '/api/providers/codex', { enabled: true });
  assert.deepEqual([turnOn.status, turnOn.body.error], [409, "Codex isn't installed: `codex` wasn't found on this machine"]);
  assert.equal((await api('PATCH', '/api/providers/nope', { enabled: true })).status, 404);

  // Every agent has a provider (Simulated unless chosen); only switched-on providers can be chosen.
  assert.ok((await api('GET', '/api/state')).body.profiles.every((p: any) => p.provider === 'simulated'));
  assert.match((await api('POST', '/api/profiles', { name: 'Codex fan', job: 'developer', provider: 'opencode' })).body.error, /OpenCode is switched off/);

  // A provider an agent runs on can't be switched off.
  const clone = await api('POST', '/api/profiles', { name: 'Grace on Claude', job: 'coordinator', provider: 'claude', model: '' });
  assert.equal(clone.status, 201, clone.raw);
  try {
    const off = await api('PATCH', '/api/providers/claude', { enabled: false });
    assert.deepEqual([off.status, off.body.error], [409, 'Claude is in use by Grace on Claude. Switch them to another provider first.']);
  } finally {
    assert.equal((await api('DELETE', `/api/profiles/${clone.body.id}`)).status, 204);
  }
});

test('pull and push cards sync the base branch with the remote, resolving conflicts first', async () => {
  const { refreshRemote } = await import('../server/settings.ts');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-remote-'));
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-clone-'));
  const tip = (dir: string) => git(dir, 'rev-parse', 'main');
  const teammate = async (file: string, content: string) => {
    fs.writeFileSync(path.join(clone, file), content);
    await git(clone, 'add', '-A');
    await git(clone, '-c', 'user.name=Teammate', '-c', 'user.email=teammate@localhost', 'commit', '-q', '-m', `Teammate changes ${file}`);
    await git(clone, 'push', '-q', 'origin', 'main');
    return tip(clone);
  };
  try {
    await git(bare, 'init', '-q', '--bare', '-b', 'main');
    await git(repo, 'remote', 'add', 'origin', bare);
    await git(repo, 'push', '-q', 'origin', 'main');
    assert.equal((await refreshRemote(DEMO))!.remoteUrl, bare);
    await git(clone, 'clone', '-q', bare, '.');

    // The remote moved and main didn't: a pull fast-forwards straight from the Backlog.
    await teammate('teammate.md', 'from a teammate\n');
    const pull = await api('POST', `/api/projects/${DEMO}/sync/pull`);
    assert.equal(pull.status, 201, pull.raw);
    const pulled = await waitFor(pull.body.id, (c) => c.stage === 'complete');
    assert.equal(pulled.statusText, 'Fast-forwarded main to origin/main');
    assert.deepEqual(stagesSeen.get(pull.body.id), ['backlog', 'complete']);
    assert.equal(await tip(repo), await tip(bare));
    assert.match((await until(() => notices(pull.body.id)[0])).body, /Pull origin\/main into main\*\* in \*\*Demo project\*\*: Fast-forwarded main to origin\/main\./);

    // Diverged with a conflict: a push merges origin/main first, a worker resolves the conflict, tests run, then main goes out.
    await commitOnMain('shared.md', 'our version\n');
    const theirs = await teammate('shared.md', 'their version\n');
    const push = (await api('POST', `/api/projects/${DEMO}/sync/push`)).body;
    const pushed = await waitFor(push.id, (c) => c.stage === 'complete', 60_000);
    assert.equal(pushed.statusText, 'Pushed main to origin');
    assert.deepEqual(stagesSeen.get(push.id), ['backlog', 'in_progress', 'verification', 'complete']);
    assert.equal(db.listSubtasks(push.id).find((s) => s.kind === 'merge')!.title, 'Resolve conflicts with origin/main');
    assert.equal(await tip(bare), await tip(repo));
    assert.equal(await git(repo, 'show', 'main:shared.md'), 'our version');
    await git(repo, 'merge-base', '--is-ancestor', theirs, 'main');

    // A merge into main queues a push afterwards.
    const done = await queueCard('# Pushed after merging\n\n- push one\n- push two');
    await waitFor(done, (c) => c.stage === 'complete' && c.worktree === null);
    await api('POST', `/api/cards/${done}/merge`);
    await waitFor(done, (c) => c.mergeState === 'merged');
    const after = await until(() => db.listCards(DEMO).find((c) => c.kind === 'push' && c.id > push.id));
    assert.match(db.listLogs(after.id).map((l) => l.text).join('\n'), new RegExp(`Queued: after merging #${done}\\.`));
    await waitFor(after.id, (c) => c.stage === 'complete');
    assert.equal(await tip(bare), await tip(repo));
  } finally {
    await git(repo, 'remote', 'remove', 'origin').catch(() => {});
    await refreshRemote(DEMO);
    fs.rmSync(bare, { recursive: true, force: true });
    fs.rmSync(clone, { recursive: true, force: true });
  }
});

after(() => fs.rmSync(otherRepo, { recursive: true, force: true }));

// ---------------------------------------------------------------- data

test('the setup exports and imports skills, agents and projects, never secrets; backups are taken on request', async () => {
  const id = (await api('POST', '/api/cards', { projectId: DEMO, description: '# Exported card', instructions: '', instructionsHash: null })).body.id;
  db.setSecrets(id, { DEPLOY_TOKEN: 'never-exported-value' });
  const exported = await api('GET', '/api/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.body.format, 'c4dev-export');
  assert.ok(exported.body.agents.some((a: any) => a.job === 'assistant' && a.name === 'Ada Lovelace'));
  assert.ok(exported.body.projects.some((p: any) => p.settings.repoPath === repo && Array.isArray(p.settings.team)));
  assert.ok(!exported.raw.includes('never-exported-value') && !exported.raw.includes('Exported card'), 'no secrets, no cards');

  const maxLoops = settingsOf(DEMO).maxLoops;
  const bundle = structuredClone(exported.body);
  const worker = bundle.agents.find((a: any) => a.job === 'developer');
  bundle.agents.push({ ...worker, name: 'Imported Ivy', provider: 'not-a-provider', model: 'x' });
  bundle.projects.find((p: any) => p.settings.repoPath === repo).settings.maxLoops = 4;
  bundle.projects.push({ name: 'Gone', settings: { repoPath: path.join(dataDir, 'no-such-repo'), team: ['Imported Ivy'] } });
  const imported = await api('POST', '/api/import', bundle);
  assert.equal(imported.status, 200, imported.raw);
  assert.ok(imported.body.added.includes('agent Imported Ivy'));
  assert.ok(imported.body.updated.includes('agent Ada Lovelace') && imported.body.updated.includes('project Demo project'));
  assert.deepEqual(imported.body.skipped.map((s: any) => s.where), ["agent Imported Ivy's provider", 'project Gone']);
  const ivy = db.activeProfiles().find((p) => p.name === 'Imported Ivy')!;
  assert.deepEqual([ivy.provider, ivy.model], ['simulated', ''], "a provider that isn't switched on here falls back to Simulated");
  assert.equal(db.profilesWithJob('assistant').length, 1, 'the Chief of Staff is updated, not duplicated');
  assert.equal(settingsOf(DEMO).maxLoops, 4);
  assert.equal((await api('POST', '/api/import', { hello: 'world' })).status, 400);

  const backup = await api('POST', '/api/backups');
  assert.equal(backup.status, 201);
  const listed = (await api('GET', '/api/backups')).body;
  assert.ok(listed.backups.some((b: any) => b.name === backup.body.name && b.name.endsWith('-manual.db')));
  assert.ok(!fs.readFileSync(backup.body.path).includes('never-exported-value'), 'secrets are encrypted in backups');
  assert.equal(listed.keyFile, path.join(dataDir, 'secret.key'));

  await api('DELETE', `/api/profiles/${ivy.id}`);
  await api('PATCH', `/api/projects/${DEMO}`, { settings: { maxLoops } });
  await api('DELETE', `/api/cards/${id}`);
});

// ---------------------------------------------------------------- budgets and limits

test('budgets stop runs before they start: the project pauses, an over-budget agent waits, the assistant declines', async () => {
  const { monthStart } = await import('../server/budget.ts');
  const tokensUsed = (column: 'project_id' | 'profile_id', id: number) => {
    const u = db.usageOf(column, id, monthStart());
    return u.inputTokens + u.outputTokens;
  };
  const draft = async (description: string) => {
    const gen = await api('POST', '/api/instructions', { description, projectId: DEMO });
    const created = await api('POST', '/api/cards', { projectId: DEMO, description, instructions: gen.body.instructions, instructionsHash: gen.body.hash });
    return created.body.id as number;
  };
  const queue = async (id: number) => assert.equal((await api('POST', `/api/cards/${id}/move`, { stage: 'backlog' })).status, 200);

  // Room for planning only: the workers' runs don't start, and nothing new starts in the project.
  const id = await draft('# Budgeted change\n\n- add a budget note to README');
  assert.equal((await api('PATCH', `/api/projects/${DEMO}`, { settings: { budgetTokens: tokensUsed('project_id', DEMO) + 1 } })).status, 200);
  await queue(id);
  await waitFor(id, (c) => c.stage === 'deliverables');
  assert.ok(db.listComments(id).some((c) => /^\*\*Budget reached:\*\* Demo project has used [\d,]+ of its [\d,]+ monthly tokens/.test(c.body)));
  assert.equal(settingsOf(DEMO).paused, true, 'the coordinator pauses');
  const subtasks = db.listSubtasks(id);
  assert.ok(subtasks.some((s) => s.status === 'blocked'), 'the next worker waits');
  assert.ok(subtasks.every((s) => s.attempts === 0 && ['blocked', 'pending'].includes(s.status)), 'no attempt is used up');
  // Raised and switched back on, the card carries on.
  await api('PATCH', `/api/projects/${DEMO}`, { settings: { budgetTokens: 0, paused: false } });
  assert.equal((await api('POST', `/api/cards/${id}/resume`, {})).status, 200);
  await waitFor(id, (c) => c.stage === 'complete' && c.worktree === null, 60_000);

  // An agent over its own budget: the only coordinator can't plan, so the card waits; the project keeps running.
  const grace = db.activeProfiles().find((p) => p.name === 'Grace Hopper')!;
  const other = await draft('# Another change\n\n- add a second note to README');
  assert.equal((await api('PATCH', `/api/profiles/${grace.id}`, { budgetTokens: 1 })).status, 200);
  await queue(other);
  const stopped = await waitFor(other, (c) => c.stage === 'deliverables');
  assert.match(stopped.statusText, /^Budget reached: Grace Hopper has used/);
  assert.equal(settingsOf(DEMO).paused, false);
  assert.equal((await api('POST', '/api/instructions', { description: 'More', projectId: DEMO })).body.type, 'error', 'Grace writes instructions too');
  await api('POST', `/api/cards/${other}/abort`);
  await api('PATCH', `/api/profiles/${grace.id}`, { budgetTokens: 0 });

  // The assistant over its budget says so instead of answering.
  const ada = db.activeProfiles().find((p) => p.job === 'assistant')!;
  await ask('Status?');
  await api('PATCH', `/api/profiles/${ada.id}`, { budgetUsd: 0, budgetTokens: 1 });
  const from = lastMessageId();
  await api('POST', '/api/assistant/messages', { body: 'How is everything going?' });
  const declined = await until(() => !assistant.busy && assistantSince(from).find((m) => m.kind === 'error'));
  assert.match(declined.body, /Ada Lovelace has used [\d,]+ of its 1 monthly tokens/);
  await api('PATCH', `/api/profiles/${ada.id}`, { budgetTokens: 0 });

  assert.equal((await api('PATCH', `/api/projects/${DEMO}`, { settings: { budgetUsd: -1 } })).status, 400);
  assert.equal((await api('PATCH', `/api/profiles/${ada.id}`, { budgetUsd: 'lots' })).status, 400);
});

test('run limits are factory-wide settings that every run receives', async () => {
  const { runProfile } = await import('../server/profiles.ts');
  assert.deepEqual((await api('GET', '/api/state')).body.limits, { maxTurns: 200, runMinutes: 60 });
  const set = await api('PATCH', '/api/limits', { maxTurns: 50 });
  assert.deepEqual(set.body, { maxTurns: 50, runMinutes: 60 });
  assert.deepEqual(runProfile(db.activeProfiles()[0]).limits, { maxTurns: 50, runMinutes: 60 });
  assert.equal((await api('PATCH', '/api/limits', { runMinutes: 0 })).status, 400);
  assert.equal((await api('PATCH', '/api/limits', { maxTurns: 2.5 })).status, 400);
  await api('PATCH', '/api/limits', { maxTurns: 200 });
});

// ---------------------------------------------------------------- contexts (MCP servers)

test('contexts are MCP servers agents can be given, with secrets that never leave the server', async () => {
  const server = path.resolve('test/fixtures/mcp-server.mjs');
  const created = await api('POST', '/api/contexts', {
    name: 'secrets', description: 'The secret word', transport: 'stdio', command: process.execPath, args: [server], env: { SECRET_WORD: 'pelican-42' },
  });
  assert.equal(created.status, 201, created.raw);
  const id = created.body.id;
  assert.deepEqual([created.body.envNames, created.body.readOnly], [['SECRET_WORD'], false]);
  assert.ok(!created.raw.includes('pelican-42'), 'values never go back to clients');
  assert.ok(!(await api('GET', '/api/state')).raw.includes('pelican-42'));
  assert.ok(!(await api('GET', '/api/export')).raw.includes('pelican-42'));

  // Check starts it and lists its tools.
  const checked = await api('POST', `/api/contexts/${id}/check`);
  assert.deepEqual(checked.body, { server: 'test-secrets 1.0.0', tools: ['secret_word'] });
  const broken = (await api('POST', '/api/contexts', { name: 'broken', transport: 'stdio', command: 'definitely-not-a-command-xyz' })).body;
  const failed = await api('POST', `/api/contexts/${broken.id}/check`);
  assert.equal(failed.status, 502);
  assert.match(failed.body.error, /^broken didn't answer: couldn't start definitely-not-a-command-xyz/);
  await api('DELETE', `/api/contexts/${broken.id}`);

  // Editing keeps a saved value when it's sent as null, and refuses one that was never saved.
  assert.equal((await api('PATCH', `/api/contexts/${id}`, { description: 'Renamed', env: { SECRET_WORD: null } })).status, 200);
  assert.deepEqual(db.contextSecrets(id).env, { SECRET_WORD: 'pelican-42' });
  assert.equal((await api('PATCH', `/api/contexts/${id}`, { env: { OTHER: null } })).status, 400);
  for (const bad of [{ name: 'has space' }, { name: 'factory' }, { name: 'SECRETS' }, { name: 'web', transport: 'http', url: 'ftp://x' }]) {
    assert.ok([400, 409].includes((await api('POST', '/api/contexts', { command: 'x', ...bad })).status), JSON.stringify(bad));
  }

  // Agents attach contexts; workers get them all, read-only runs only read-only ones.
  const { runProfile } = await import('../server/profiles.ts');
  const { contextsFor } = await import('../server/agents/driver.ts');
  const alex = db.activeProfiles().find((p) => p.name === 'Alex')!;
  const attached = await api('PATCH', `/api/profiles/${alex.id}`, { contextIds: [id, 9999] });
  assert.deepEqual(attached.body.contextIds, [id], 'unknown contexts are dropped');
  const run = runProfile(db.getProfile(alex.id)!);
  assert.deepEqual(run.contexts.map((c) => [c.name, c.env.SECRET_WORD]), [['secrets', 'pelican-42']]);
  assert.equal(contextsFor(run, true).length, 1);
  assert.equal(contextsFor(run, false).length, 0, 'not read-only, so planners and reviewers never get it');
  await api('PATCH', `/api/contexts/${id}`, { readOnly: true });
  assert.equal(contextsFor(runProfile(db.getProfile(alex.id)!), false).length, 1);

  // Workers say which contexts they have.
  await api('PATCH', `/api/projects/${DEMO}`, { settings: { team: [alex.id, ...db.activeProfiles().filter((p) => p.job !== 'developer').map((p) => p.id)] } });
  const card = await queueCard('# Use the secret word\n\n- write it into notes.md');
  await waitFor(card, (c) => db.listLogs(c.id).some((l) => l.text === 'Using contexts: secrets'));
  await api('POST', `/api/cards/${card}/abort`);
  await api('PATCH', `/api/projects/${DEMO}`, { settings: { team: [] } });

  // Deleting a context detaches it from every agent.
  assert.equal((await api('DELETE', `/api/contexts/${id}`)).status, 204);
  assert.deepEqual(db.getProfile(alex.id)!.contextIds, []);
});

test('a context reached over HTTP is checked with its headers', async () => {
  // A minimal streamable-HTTP MCP server that wants a bearer token and answers in an event stream.
  const mcp = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer t0ken') return res.writeHead(401).end();
      const msg = JSON.parse(body);
      if (msg.id === undefined) return res.writeHead(202).end();
      const result = msg.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'docs', version: '2' } }
        : { tools: [{ name: 'search' }, { name: 'fetch' }] };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' }).end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
    });
  }).listen(0);
  const url = `http://localhost:${(mcp.address() as AddressInfo).port}/mcp`;
  try {
    const created = (await api('POST', '/api/contexts', { name: 'docs', transport: 'http', url, headers: { Authorization: 'Bearer t0ken' }, readOnly: true })).body;
    assert.deepEqual(created.headerNames, ['Authorization']);
    assert.deepEqual((await api('POST', `/api/contexts/${created.id}/check`)).body, { server: 'docs 2', tools: ['search', 'fetch'] });
    await api('PATCH', `/api/contexts/${created.id}`, { headers: { Authorization: 'Bearer wrong' } });
    const denied = await api('POST', `/api/contexts/${created.id}/check`);
    assert.match(denied.body.error, /HTTP 401 \(check the headers/);
    await api('DELETE', `/api/contexts/${created.id}`);
  } finally {
    mcp.close();
  }
});

test('contexts take values from the factory environment, start in their working directory and can be switched off', async () => {
  const { resolveContext, runContexts } = await import('../server/contexts.ts');
  const server = path.resolve('test/fixtures/mcp-server.mjs');
  process.env.FACTORY_TEST_WORD = 'from-the-environment';
  process.env.FACTORY_TEST_TOKEN = 't0k';
  try {
    // Passthrough: the server gets the factory's own variable by name, and Check reaches it.
    const passed = (await api('POST', '/api/contexts', { name: 'passthrough', transport: 'stdio', command: process.execPath, args: [server], envPassthrough: ['FACTORY_TEST_WORD'] })).body;
    assert.deepEqual(passed.envPassthrough, ['FACTORY_TEST_WORD']);
    const run = resolveContext(db.getContext(passed.id)!);
    assert.equal(run.env.FACTORY_TEST_WORD, 'from-the-environment');
    assert.deepEqual(run.missing, []);

    // A working directory wraps the command, so every provider starts it there.
    await api('PATCH', `/api/contexts/${passed.id}`, { cwd: '~' });
    const wrapped = resolveContext(db.getContext(passed.id)!);
    assert.deepEqual([wrapped.command, wrapped.args.slice(2)], ['/bin/sh', ['sh', os.homedir(), process.execPath, server]]);
    assert.deepEqual((await api('POST', `/api/contexts/${passed.id}/check`)).body.tools, ['secret_word']);

    // A variable the factory doesn't have is named when the check fails.
    const broken = (await api('POST', '/api/contexts', { name: 'unset', transport: 'stdio', command: 'definitely-not-a-command-xyz', envPassthrough: ['FACTORY_TEST_NOPE'] })).body;
    assert.match((await api('POST', `/api/contexts/${broken.id}/check`)).body.error, /not set in the factory's environment: FACTORY_TEST_NOPE/);

    // HTTP: a bearer token and headers from the environment, beside saved headers.
    const web = (await api('POST', '/api/contexts', {
      name: 'web', transport: 'http', url: 'http://127.0.0.1:9/mcp', bearerTokenEnv: 'FACTORY_TEST_TOKEN', envHeaders: { 'X-Word': 'FACTORY_TEST_WORD' }, headers: { 'X-Saved': 's' },
    })).body;
    assert.deepEqual(resolveContext(db.getContext(web.id)!).headers, { Authorization: 'Bearer t0k', 'X-Word': 'from-the-environment', 'X-Saved': 's' });
    assert.equal((await api('POST', '/api/contexts', { name: 'bad-env', transport: 'http', url: 'http://x/mcp', bearerTokenEnv: 'not valid' })).status, 400);

    // Switched off, it stays attached but no run starts it.
    const alex = db.activeProfiles().find((p) => p.name === 'Alex')!;
    await api('PATCH', `/api/profiles/${alex.id}`, { contextIds: [passed.id, web.id] });
    assert.deepEqual(runContexts(db.getProfile(alex.id)!).map((c) => c.name), ['passthrough', 'web']);
    assert.equal((await api('PATCH', `/api/contexts/${web.id}`, { enabled: false })).body.enabled, false);
    assert.deepEqual(runContexts(db.getProfile(alex.id)!).map((c) => c.name), ['passthrough']);
    assert.deepEqual(db.getProfile(alex.id)!.contextIds, [passed.id, web.id], 'still attached');

    for (const id of [passed.id, broken.id, web.id]) await api('DELETE', `/api/contexts/${id}`);
  } finally {
    delete process.env.FACTORY_TEST_WORD;
    delete process.env.FACTORY_TEST_TOKEN;
  }
});

test('a local folder is a context agents read from its AGENTS.md or CONTEXT.md, without any server', async () => {
  const { runProfile } = await import('../server/profiles.ts');
  const { contextsFor } = await import('../server/agents/driver.ts');
  const { profileBrief } = await import('../server/prompts.ts');
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-kb-'));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-kb-empty-'));
  try {
    fs.mkdirSync(path.join(kb, '.agents', 'context'), { recursive: true });
    fs.writeFileSync(path.join(kb, '.agents', 'AGENTS.md'), '# Knowledge\n\n- Product facts: [product](context/product.md)\n');
    fs.writeFileSync(path.join(kb, '.agents', 'context', 'product.md'), '# Product\n\nThe launch codename is ORCHID-913.\n');

    // It needs an entry document; .agents/ (the ChrisAI Agent Workspace) counts.
    assert.match((await api('POST', '/api/contexts', { name: 'nokb', transport: 'folder', folder: empty })).body.error, /has no AGENTS\.md, CONTEXT\.md/);
    assert.match((await api('POST', '/api/contexts', { name: 'nokb', transport: 'folder', folder: path.join(empty, 'missing') })).body.error, /^No folder at/);
    const created = await api('POST', '/api/contexts', { name: 'kb', transport: 'folder', folder: kb, readOnly: false });
    assert.equal(created.status, 201, created.raw);
    assert.equal(created.body.readOnly, true, 'agents only read it, so every role may have it');
    assert.deepEqual((await api('POST', `/api/contexts/${created.body.id}/check`)).body, { server: '.agents/AGENTS.md', tools: [], files: 2 });

    // The entry document goes into every run's instructions, read-only roles included.
    const grace = db.activeProfiles().find((p) => p.name === 'Grace Hopper')!;
    await api('PATCH', `/api/profiles/${grace.id}`, { contextIds: [created.body.id] });
    const run = runProfile(db.getProfile(grace.id)!);
    assert.equal(contextsFor(run, false).length, 1);
    const brief = profileBrief(run);
    assert.match(brief, /## Project knowledge: kb/);
    assert.ok(brief.includes(path.join(kb, '.agents', 'AGENTS.md')) && brief.includes('[product](context/product.md)'));
    assert.match(brief, /Never edit files in that folder/);
    assert.ok(!brief.includes('ORCHID-913'), 'linked files are read when needed, not inlined');

    // A root AGENTS.md wins over .agents/, and a long one is cut with a note.
    fs.writeFileSync(path.join(kb, 'AGENTS.md'), `# Root\n${'x'.repeat(30_000)}`);
    const long = profileBrief(runProfile(db.getProfile(grace.id)!));
    assert.ok(long.includes(path.join(kb, 'AGENTS.md')) && long.includes('cut at 24000 characters'));
    // Switched off, it leaves the brief.
    await api('PATCH', `/api/contexts/${created.body.id}`, { enabled: false });
    assert.doesNotMatch(profileBrief(runProfile(db.getProfile(grace.id)!)), /Project knowledge/);

    await api('DELETE', `/api/contexts/${created.body.id}`);
    assert.deepEqual(db.getProfile(grace.id)!.contextIds, []);
  } finally {
    fs.rmSync(kb, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("Choose… opens this machine's own folder dialog, starting at the nearest folder that exists", async () => {
  nextDialog = { path: '/Users/someone/code/shop', supported: true };
  const chosen = await api('POST', '/api/fs/choose-folder', { start: path.join(repo, 'no', 'such', 'folder'), title: 'Choose the project folder' });
  assert.deepEqual(chosen.body, { path: '/Users/someone/code/shop', supported: true });
  assert.deepEqual(dialogs.at(-1), { start: repo, title: 'Choose the project folder' });
  await api('POST', '/api/fs/choose-folder', { start: '' });
  assert.equal(dialogs.at(-1)!.start, os.homedir(), 'nothing typed starts at home');
  // Cancelling, and machines without a dialog (the page then shows its own picker).
  nextDialog = { path: null, supported: true };
  assert.deepEqual((await api('POST', '/api/fs/choose-folder', {})).body, { path: null, supported: true });
  nextDialog = { path: null, supported: false };
  assert.deepEqual((await api('POST', '/api/fs/choose-folder', {})).body, { path: null, supported: false });
});

test('a project logo is an uploaded image or a link, and travels inside exports', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const upload = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-factory-token': token }, body: png });
  const { url } = await upload.json();
  for (const ok of [url, 'https://cdn.example.com/logo.svg', '']) {
    assert.equal((await api('PATCH', `/api/projects/${DEMO}`, { settings: { logoUrl: ok } })).status, 200, ok);
  }
  for (const bad of ['javascript:alert(1)', 'logo.png', 'ftp://x/logo.png', '/uploads/../secret.key']) {
    assert.equal((await api('PATCH', `/api/projects/${DEMO}`, { settings: { logoUrl: bad } })).status, 400, bad);
  }
  // Exported as the image itself, so it survives the move to another machine.
  await api('PATCH', `/api/projects/${DEMO}`, { settings: { logoUrl: url } });
  const exported = (await api('GET', '/api/export')).body;
  const demo = exported.projects.find((p: any) => p.settings.repoPath === repo);
  assert.match(demo.settings.logoUrl, /^data:image\/png;base64,/);
  await api('PATCH', `/api/projects/${DEMO}`, { settings: { logoUrl: '' } });
  assert.equal((await api('POST', '/api/import', exported)).status, 200);
  assert.match(settingsOf(DEMO).logoUrl, /^\/uploads\/[\w-]+\.png$/);
  await api('PATCH', `/api/projects/${DEMO}`, { settings: { logoUrl: '' } });
});

// ---------------------------------------------------------------- Jev (optional decision model)

test('Jev is optional: added with a checked key it settles routine decisions, and without it everything works as before', async () => {
  // A stand-in TypeSafe API: GET /v1/models checks the key, POST /v1/systemone answers from `respond`.
  type Q = Record<string, { type: string }>;
  let respond: (questions: Q) => Record<string, unknown> | null = () => null;
  const asked: Q[] = [];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer good-key') return res.writeHead(401).end();
      if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"models":[{"name":"jev-latest"}]}');
      const { questions } = JSON.parse(body);
      asked.push(questions);
      const answers = respond(questions);
      if (!answers) return res.writeHead(500).end();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: 'jev-1', answers, usage: { input_tokens: 40, output_tokens: 2 } }));
    });
  }).listen(0);
  process.env.TYPESAFE_BASE_URL = `http://localhost:${(fake.address() as AddressInfo).port}`;
  const ada = db.activeProfiles().find((p) => p.job === 'assistant')!;
  const adaRuns = () => db.usageOf('profile_id', ada.id, 0).runs;
  const noul = (p: number) => ({ type: 'noul', noul: p });
  try {
    // Without Jev, the Status button is still answered from the boards, with no model run.
    assert.equal((await api('GET', '/api/state')).body.jev.configured, false);
    let runs = adaRuns();
    const { STATUS_QUESTION } = await import('../server/types.ts');
    const status = await ask(STATUS_QUESTION);
    assert.match(status.find((m) => m.kind === 'message')!.body, /\*\*Demo project\*\*/);
    assert.equal(adaRuns(), runs, 'no assistant run for Status');

    // Adding it checks the key; the key never reaches clients or exports.
    const refused = await api('PUT', '/api/jev', { apiKey: 'bad-key' });
    assert.deepEqual([refused.status, refused.body.error], [400, 'TypeSafe refused that API key']);
    assert.deepEqual((await api('PUT', '/api/jev', { apiKey: 'good-key' })).body, { configured: true, enabled: true, model: 'jev-latest' });
    assert.ok(!(await api('GET', '/api/state')).raw.includes('good-key') && !(await api('GET', '/api/export')).raw.includes('good-key'));

    // A description too vague to work from comes back before the instructions run, unless the user insists.
    respond = (q) => (q.specificity ? { specificity: { type: 'score', score: 0.1, confidence: 0.95 } } : null);
    const vague = await api('POST', '/api/instructions', { description: 'Fix it', projectId: DEMO });
    assert.equal(vague.body.type, 'vague');
    assert.equal((await api('POST', '/api/instructions', { description: 'Fix it', projectId: DEMO, force: true })).body.type, 'done');

    // A status question in other words is recognised and answered without the assistant's model.
    respond = (q) => (q.status ? { status: noul(0.91), project: { type: 'choice', choice: 'all', confidence: 0.99, probabilities: {} } } : null);
    runs = adaRuns();
    assert.match((await ask('how are things looking?')).find((m) => m.kind === 'message')!.body, /\*\*Demo project\*\*/);
    assert.equal(adaRuns(), runs);
    assert.ok(asked.some((q) => q.status), 'Jev was asked');

    // A small card skips planning, and a confident "nothing needs a human" skips the approval run:
    // without Jev the simulated coordinator would ask for approval because the description says "review".
    respond = (q) => (q.single_change ? { single_change: noul(0.96) }
      : q.credentials ? { credentials: noul(0.02), sensitive: noul(0.03), open_ux: noul(0.05), assumptions: noul(0.04), review_requested: noul(0.08) }
      : q.specificity ? { specificity: { type: 'score', score: 2.8, confidence: 0.9 } } : null);
    const id = await queueCard('# Review the footer copy\n\nUpdate the footer text to say "Made with care" and review it.');
    const done = await waitFor(id, (c) => c.stage === 'complete' && c.worktree === null, 60_000);
    assert.equal(done.deliverableKind, null);
    const logs = db.listLogs(id).map((l) => l.text);
    assert.ok(logs.includes('Jev: a single small change, so no planning run'));
    assert.ok(logs.some((t) => /^Approval needed: no\. Jev found nothing that needs a human/.test(t)), logs.join('\n'));
    assert.equal(db.listSubtasks(id).filter((s) => s.kind === 'build').length, 1);
    // Both Jev calls (planning, approval) are charged to the card at TypeSafe's estimate:
    // $0.042 per million input tokens, output free. Simulated runs cost nothing.
    assert.ok(Math.abs(db.cardUsage(id).costUsd - 2 * 40 * 0.042 / 1_000_000) < 1e-12, String(db.cardUsage(id).costUsd));

    // One criterion that isn't a confident no (here: touches auth) leaves the decision to the LLM.
    const { approvalByJev, singleChangeByJev } = await import('../server/decisions.ts');
    respond = (q) => (q.credentials ? { credentials: noul(0.02), sensitive: noul(0.6), open_ux: noul(0.05), assumptions: noul(0.04), review_requested: noul(0.02) }
      : q.single_change ? { single_change: noul(0.85) } : null);
    assert.equal(await approvalByJev(done, db.listSubtasks(id), { projectId: DEMO, cardId: id }), null);
    assert.equal(await singleChangeByJev(done, { projectId: DEMO, cardId: id }), false, 'unsure means plan as usual');

    // When Jev fails, everything falls back to the old path.
    respond = () => null;
    assert.equal((await api('POST', '/api/instructions', { description: 'Fix it', projectId: DEMO })).body.type, 'done');

    // Switched off, or removed, it isn't asked at all.
    const before = asked.length;
    assert.equal((await api('PUT', '/api/jev', { enabled: false })).body.enabled, false);
    runs = adaRuns();
    await ask('how are things looking?');
    assert.ok(adaRuns() > runs, 'the assistant model answers again');
    assert.equal(asked.length, before);
    assert.deepEqual((await api('DELETE', '/api/jev')).body, { configured: false, enabled: true, model: 'jev-latest' });
  } finally {
    await api('DELETE', '/api/jev');
    delete process.env.TYPESAFE_BASE_URL;
    fake.close();
  }
});

// ---------------------------------------------------------------- usage reports

test('usage reports show tokens and estimated cost per day and per model, for all projects or one', async () => {
  const shopRepo = path.join(dataDir, 'usage-shop');
  fs.mkdirSync(shopRepo, { recursive: true });
  await git(shopRepo, 'init', '-q', '-b', 'main');
  const shop = await api('POST', '/api/projects', { name: 'Usage shop', settings: { repoPath: shopRepo } });
  assert.equal(shop.status, 201, shop.raw);
  const projectId: number = shop.body.id;
  const day = (offset: number) => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - offset);
    return d;
  };
  const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const run = (offset: number, model: string, projectIdFor: number, tokens: number, cost: number) => db.addUsage({
    projectId: projectIdFor, cardId: null, profileId: null, model, ts: day(offset).getTime(),
    inputTokens: tokens, outputTokens: tokens / 10, cacheReadTokens: tokens * 2, cacheWriteTokens: 0, costUsd: cost,
  });
  const before = (await api('GET', `/api/usage/report?days=7&projectId=${projectId}`)).body;
  run(0, 'report-opus', projectId, 1000, 0.5);
  run(0, 'report-haiku', projectId, 4000, 0.04);
  run(3, 'report-opus', projectId, 2000, 1.0);
  run(10, 'report-opus', projectId, 9000, 9.0); // outside a 7-day range

  const week = (await api('GET', `/api/usage/report?days=7&projectId=${projectId}`)).body;
  assert.equal(week.days.length, 7, 'every day, oldest first, even without runs');
  assert.equal(week.days.at(-1).day, key(day(0)));
  assert.equal(week.days.at(-1).inputTokens - before.days.at(-1).inputTokens, 5000);
  assert.equal(week.days.at(-4).day, key(day(3)));
  assert.equal(week.days.at(-4).outputTokens - before.days.at(-4).outputTokens, 200);
  const models = Object.fromEntries(week.models.map((m: any) => [m.model, m]));
  assert.deepEqual([models['report-opus'].runs, models['report-opus'].inputTokens, models['report-opus'].costUsd], [2, 3000, 1.5]);
  assert.deepEqual([models['report-haiku'].cacheReadTokens, models['report-haiku'].costUsd], [8000, 0.04]);
  assert.equal(week.models[0].model, 'report-opus', 'most expensive first');
  assert.ok(Math.abs(week.total.costUsd - before.total.costUsd - 1.54) < 1e-9);

  const fortnight = (await api('GET', `/api/usage/report?days=14&projectId=${projectId}`)).body;
  assert.equal(fortnight.days.length, 14);
  assert.equal(Object.fromEntries(fortnight.models.map((m: any) => [m.model, m]))['report-opus'].runs, 3);
  // All projects include this one; another project's report doesn't.
  assert.ok((await api('GET', '/api/usage/report?days=7')).body.models.some((m: any) => m.model === 'report-haiku'));
  assert.ok(!(await api('GET', `/api/usage/report?days=7&projectId=${DEMO}`)).body.models.some((m: any) => m.model === 'report-haiku'));
  for (const bad of ['0', '400', 'week']) assert.equal((await api('GET', `/api/usage/report?days=${bad}`)).status, 400);
  assert.equal((await api('GET', '/api/usage/report?days=7&projectId=9999')).status, 404);
});
