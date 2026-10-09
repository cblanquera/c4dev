import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeCoverage, parseCoverage } from '../server/coverage.ts';
import { deriveTitle, parseTags } from '../server/db.ts';

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
