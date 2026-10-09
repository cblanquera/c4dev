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
const { createApp } = await import('../server/app.ts');
const { SimulatedDriver } = await import('../server/agents/simulated.ts');
const { subscribe } = await import('../server/events.ts');
const { DevmetricsProcesses } = await import('../server/processes.ts');
const { git } = await import('../server/shell.ts');

let server: Server;
let base: string;
let coordinator: InstanceType<typeof Coordinator>;
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

/** Creates a card with generated instructions and drags it to the backlog. */
async function queueCard(description: string) {
  const gen = await api('POST', '/api/instructions', { description });
  assert.equal(gen.body.type, 'done');
  const created = await api('POST', '/api/cards', { description, instructions: gen.body.instructions, instructionsHash: gen.body.hash });
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
  updateSettings({ maxActiveCards: 3, maxWorkers: 3 });
  subscribe((e) => {
    if (e.type !== 'card') return;
    const seen = stagesSeen.get(e.card.id) ?? [];
    if (seen.at(-1) !== e.card.stage) seen.push(e.card.stage);
    stagesSeen.set(e.card.id, seen);
  });
  const driver = new SimulatedDriver();
  coordinator = new Coordinator(() => driver);
  const processes = new DevmetricsProcesses(() => [repo], async (args) => {
    if (args[0] === 'list') return JSON.stringify(managedProcesses);
    processStops.push(args[1]);
    managedProcesses = managedProcesses.filter((item) => String(item.port) !== args[1]);
    return '';
  });
  server = createApp(coordinator, () => driver, processes).listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  coordinator.start();
});

after(async () => {
  await coordinator.stop();
  server.close();
  db.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('cards need current instructions before entering the backlog', async () => {
  const created = await api('POST', '/api/cards', { description: 'No instructions yet' });
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
  await waitFor(id, () => db.listComments(id).length > commentsBeforeQuestion + 1 && !coordinator.isChatBusy(id));
  assert.equal(db.getCard(id)!.stage, 'deliverables');
  assert.equal(db.getCard(id)!.deliverableKind, 'input');

  await api('POST', `/api/cards/${id}/comment`, { body: 'Here is the key you asked for', secrets: { ACME_API_KEY: 'sk-test' } });
  await waitFor(id, (c) => c.stage === 'deliverables' && c.deliverableKind === 'approval');
  assert.deepEqual(db.getCard(id)!.secretNames, ['ACME_API_KEY']);

  const approved = await api('POST', `/api/cards/${id}/approve`, { note: 'Checked against staging' });
  assert.equal(approved.body.stage, 'complete');
});

test('aborting a running card stops it and returns it to the Icebox', async () => {
  updateSettings({ paused: true });
  const id = await queueCard('# Long task\n\n- step one\n- step two\n- step three');
  updateSettings({ paused: false });
  coordinator.tick();
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
    await waitFor(card.id, () => db.listComments(card.id).length > count + 1 && !coordinator.isChatBusy(card.id));
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
  const waiting = new Coordinator(() => driver);
  const created = db.createCard({ description: '# Chat while queued', instructions: 'Do this', instructionsHash: null });
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
  const created = db.createCard({ description: '# Legacy result', instructions: '', instructionsHash: null });
  db.moveCard(created.id, 'complete');
  db.setSecrets(created.id, { LEGACY_TOKEN: 'synthetic-private-value' });
  const detail = (await api('GET', `/api/cards/${created.id}`)).body;
  assert.match(detail.deliveryNotes, /no preview URL recorded/);
  assert.match(detail.deliveryNotes, /No passing verification results recorded/);
  await api('POST', `/api/cards/${created.id}/comment`, { body: 'What does synthetic-private-value mean here?' });
  await waitFor(created.id, () => !coordinator.isChatBusy(created.id));
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
