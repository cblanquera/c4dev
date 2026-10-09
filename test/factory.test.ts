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
import type { Server } from 'node:http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-'));
process.env.FACTORY_DATA = dataDir;
process.env.FACTORY_SIM_SPEED = '0';

const db = await import('../server/db.ts');
const { initSettings, updateSettings, defaultSettings } = await import('../server/settings.ts');
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
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text.split('\n').filter(Boolean).at(-1)!) : null, raw: text };
}

async function waitFor(cardId: number, pred: (c: any) => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const card = db.getCard(cardId)!;
    if (pred(card)) return card;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out; card #${cardId} is ${JSON.stringify(db.getCard(cardId))}`);
}

async function until<T>(fn: () => T | null | undefined | false, ms = 30_000): Promise<T> {
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
  server = createApp(factory, assistant, processes).listen(0);
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

test('completed cards record whether their branch reached the base branch', async () => {
  const { isAncestor } = await import('../server/git.ts');
  const notice = (id: number) => until(() => db.listAssistantMessages(500).find((m) => m.kind === 'notification' && m.cardIds[0] === id));

  // Kept by default; a merge made by hand afterwards is noticed.
  const kept = db.listCards(DEMO).find((c) => c.stage === 'complete' && c.branch && c.mergeState === 'unmerged')!;
  assert.equal(kept.mergeNote, `Kept on factory/card-${kept.id}`);
  await git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'merge', '--no-ff', '-m', 'Manual merge', `factory/card-${kept.id}`);
  await factory.coordinator(DEMO).refreshMergeStates();
  assert.deepEqual([db.getCard(kept.id)!.mergeState, db.getCard(kept.id)!.mergeNote], ['merged', 'Merged into main']);

  updateSettings(DEMO, { onComplete: 'merge' });
  const scratch = path.join(repo, 'scratch.txt');
  try {
    const merged = await queueCard('# Merge me\n\n- merge one\n- merge two');
    assert.equal((await waitFor(merged, (c) => c.stage === 'complete' && c.worktree === null)).mergeState, 'merged');
    assert.equal(await isAncestor(repo, `factory/card-${merged}`, 'main'), true);
    assert.match((await notice(merged)).body, /is complete in \*\*Demo project\*\*\. Merged into main\./);

    // A dirty main checkout is never touched: the branch is kept and the reason recorded.
    fs.writeFileSync(scratch, 'work in progress');
    const blocked = await queueCard('# Blocked merge\n\n- block one\n- block two');
    const card = await waitFor(blocked, (c) => c.stage === 'complete' && c.worktree === null);
    assert.equal(card.mergeState, 'blocked');
    assert.equal(card.mergeNote, `Kept on factory/card-${blocked}: main checkout has uncommitted changes`);
    assert.equal(await isAncestor(repo, `factory/card-${blocked}`, 'main'), false);
    assert.match((await notice(blocked)).body, /Merge blocked: main checkout has uncommitted changes; the work is on `factory\/card-\d+`\./);
  } finally {
    fs.rmSync(scratch, { force: true });
    updateSettings(DEMO, { onComplete: 'keep' });
  }
});

test('merging a completed card lands verified code, re-verifying it when main has moved', async () => {
  const { isAncestor } = await import('../server/git.ts');
  const commitOnMain = async (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
    await git(repo, 'add', '-A');
    await git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', `Change ${file} on main`);
  };
  const notices = (id: number) => db.listAssistantMessages(500).filter((m) => m.kind === 'notification' && m.cardIds[0] === id);
  const landed = (id: number) => waitFor(id, (c) => c.stage === 'complete' && !c.merging && c.worktree === null && c.mergeState !== 'unmerged');

  // main hasn't moved since the card branched: it lands without leaving Complete.
  const fast = await queueCard('# Fast merge\n\n- fast one\n- fast two');
  await waitFor(fast, (c) => c.stage === 'complete' && c.worktree === null);
  const stagesBefore = stagesSeen.get(fast)!.length;
  assert.equal((await api('POST', `/api/cards/${fast}/merge`)).status, 200);
  assert.equal((await landed(fast)).mergeState, 'merged');
  assert.equal(stagesSeen.get(fast)!.length, stagesBefore);
  assert.equal(await isAncestor(repo, `factory/card-${fast}`, 'main'), true);
  assert.equal((await api('POST', `/api/cards/${fast}/merge`)).status, 409);
  assert.match((await until(() => notices(fast).find((m) => /Merged into main/.test(m.body)))).body, /in \*\*Demo project\*\*: Merged into main\./);

  // main moved and conflicts: a worker resolves it, then the card is verified again before main moves.
  const clash = await queueCard('# Conflicting merge\n\n- clash one\n- clash two');
  await waitFor(clash, (c) => c.stage === 'complete' && c.worktree === null);
  const file = db.listSubtasks(clash).flatMap((s) => s.files).find((f) => f.path.startsWith('factory-sim/'))!.path;
  const cardVersion = await git(repo, 'show', `factory/card-${clash}:${file}`);
  await commitOnMain(file, 'the main branch version\n');
  const seen = stagesSeen.get(clash)!.length;
  await ask(`merge #${clash}`, (messages) => messages.some((m) => m.kind === 'action'));
  const merged = await landed(clash);
  assert.equal(merged.mergeState, 'merged', merged.mergeNote);
  assert.deepEqual(stagesSeen.get(clash)!.slice(seen), ['in_progress', 'verification', 'acceptance', 'complete']);
  const resolution = db.listSubtasks(clash).find((s) => s.kind === 'merge')!;
  assert.deepEqual([resolution.title, resolution.status], ['Resolve conflicts with main', 'done']);
  assert.equal(await git(repo, 'show', `main:${file}`), cardVersion);
  assert.equal(await isAncestor(repo, `factory/card-${clash}`, 'main'), true);
  await until(() => notices(clash).find((m) => /Merged into main/.test(m.body)));
  assert.equal(notices(clash).filter((m) => /is complete/.test(m.body)).length, 1, 'the merge pass reports once, when it lands');

  // The merge can be audited: who asked, every stage change with its reason, and each git command with its SHAs.
  const trail = db.listLogs(clash).filter((l) => l.actor === 'coordinator' && l.level === 'summary').map((l) => l.text);
  const has = (re: RegExp) => assert.ok(trail.some((t) => re.test(t)), `${re}\n${trail.join('\n')}`);
  has(/^You asked to merge factory\/card-\d+ into main, through the assistant\.$/);
  has(/^main has moved since factory\/card-\d+ was verified/);
  has(/^\*\*Complete → In Progress\*\*: main conflicts with factory\/card-\d+ in `factory-sim\/[^`]+` \(merge attempt 1\/5\); a worker resolves them$/);
  has(/^\*\*In Progress → Verification\*\*: all subtasks merged into the card branch$/);
  has(/^\*\*Acceptance → Complete\*\*: the update from main passed verification and acceptance$/);
  has(/^Merged factory\/card-\d+ into main\./);
  const details = db.listLogs(clash).filter((l) => l.level === 'detail').map((l) => l.text).join('\n');
  assert.match(details, /\$ git merge-base --is-ancestor main factory\/card-\d+ {2}# main at \w{7} is not in factory\/card-\d+ at \w{7}/);
  assert.match(details, /\$ git merge --no-ff main\n[\s\S]*CONFLICT[\s\S]*\$ git merge --abort/);
  assert.match(details, /# main: \w{7} → \w{7}/);

  // Cancelling a merge pass returns the card to Complete with its branch kept, not archived.
  const stop = await queueCard('# Cancelled merge\n\n- stop one\n- stop two');
  await waitFor(stop, (c) => c.stage === 'complete' && c.worktree === null);
  await commitOnMain(`notes/moved-${stop}.md`, 'main moves on\n');
  await api('POST', `/api/cards/${stop}/merge`);
  await waitFor(stop, (c) => ['in_progress', 'verification', 'acceptance'].includes(c.stage));
  const cancelled = (await api('POST', `/api/cards/${stop}/abort`)).body;
  assert.deepEqual([cancelled.stage, cancelled.merging, cancelled.mergeState, cancelled.branch], ['complete', false, 'unmerged', `factory/card-${stop}`]);
  assert.match(cancelled.mergeNote, /^Merge cancelled/);
  assert.match(await git(repo, 'branch', '--list', `factory/card-${stop}`), /card/);
  assert.match((await until(() => notices(stop).find((m) => /cancelled/.test(m.body)))).body, /work stays on `factory\/card-\d+`/);
});

after(() => fs.rmSync(otherRepo, { recursive: true, force: true }));
