import { expect, test } from '../helpers.ts';
import type { Card, CardDetail, LogEntry, Subtask } from '../../server/types.ts';
import { expectNoHorizontalOverflow } from '../helpers.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test('named team bubbles preserve details, and the Markdown composer stays below scrolling history', async ({ page, request }) => {
  const state = await (await request.get('/api/state')).json();
  const now = Date.now();
  const card: Card = {
    id: 900010, projectId: 1, kind: 'task', title: 'Team conversation fixture', description: 'Review the team conversation.',
    instructions: 'Inspect the activity.', instructionsHash: 'current', instructionsCurrent: true,
    stage: 'complete', position: 0, status: 'idle', statusText: 'Complete', tags: [], parentId: null,
    branch: 'factory/card-900010', worktree: null, loops: 0, coverage: 100, acceptanceReady: true,
    deliverableKind: null, resumeStage: null, secretNames: [], hidden: false,
    createdAt: now, updatedAt: now, stageChangedAt: now, completedAt: now,
  };
  const log = (id: number, actor: string, level: LogEntry['level'], text: string, subtaskId: number | null = null): LogEntry => ({ id, cardId: card.id, subtaskId, actor, level, text, ts: now + id });
  const task = (id: number, title: string, kind: Subtask['kind']): Subtask => ({
    id, cardId: card.id, seq: id, round: 1, kind, title, instructions: 'Inspect the role context.', doneWhen: 'Context is shown.', dependsOn: [], status: 'done', worker: `worker-${id}`,
    branch: null, worktree: null, summary: '', diff: '', files: [], attempts: 1, startedAt: now, endedAt: now + 10,
  });
  const detail: CardDetail = {
    card, subtasks: [task(5, 'Implement timezone selector', 'build'), task(6, 'Write acceptance scripts', 'acceptance'), task(2, 'Design timezone selector layout', 'build')], chatBusy: false, usage: { runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, deliveryNotes: '# How to review\n\nOpen the local preview.',
    logs: [
      log(1, 'coordinator', 'summary', 'Please check the timezone handling.'),
      log(2, 'worker-5', 'summary', 'The timezone selector is ready.', 5),
      log(3, 'coordinator', 'detail', 'Coordinator verification output'),
      log(4, 'worker-5', 'detail', 'Worker test output\nAll cases passed.', 5),
      log(5, 'senior', 'summary', 'The edge cases look good.'),
      log(6, 'senior', 'detail', 'Senior audit reasoning'),
      log(7, 'worker-6', 'detail', 'Standalone error\nNo summary was recorded.', 6),
      log(8, 'worker-2', 'summary', 'The selector layout is sketched.', 2),
    ],
    comments: Array.from({ length: 40 }, (_, i) => ({ id: i + 1, cardId: card.id, author: i % 2 ? 'user' as const : 'coordinator' as const, kind: 'note' as const, body: `Conversation message ${i}\n\nA longer message to make the history scroll.`, via: null, ts: now + i })),
  };
  await page.route('**/api/state', (route) => route.fulfill({ json: { ...state, cards: [card, { ...card, id: 900011, title: 'Referenced task' }] } }));
  await page.route(`**/api/cards/${card.id}`, (route) => route.fulfill({ json: detail }));
  await page.route('**/api/events', (route) => route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' }));
  await page.goto(`/#card-${card.id}`);
  await expect(page.locator('.brand')).toHaveText('');
  await expect(page.getByRole('img', { name: 'Software Factory', exact: true })).toBeVisible();
  const tabs = page.getByRole('tablist', { name: 'Card sections' });
  await tabs.getByRole('tab', { name: 'Activity', exact: true }).click();
  const views = page.getByRole('tablist', { name: 'Activity views' });
  await expect(views.getByRole('tab')).toHaveText(['Team Chat', 'Logs', 'Diffs']);
  await expect(views.getByRole('tab', { name: 'Team Chat', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(views.locator('.count')).toHaveCount(0);
  await page.getByText('About the agent jobs', { exact: true }).click();
  await expect(page.locator('.agent-profiles')).toContainText('Names identify agent profiles');
  await expect(page.locator('.agent-profiles')).toContainText('read-only access');
  await page.getByText('About the agent jobs', { exact: true }).click();
  await expect(page.getByRole('tab', { name: /^Details/ })).toHaveCount(0);
  const coordinator = page.getByRole('article', { name: 'Grace Hopper · Coordinator', exact: true });
  const worker = page.getByRole('article', { name: 'Casey · Worker', exact: true });
  const senior = page.getByRole('article', { name: 'Linus Torvalds · Architect', exact: true });
  expect((await coordinator.boundingBox())!.x).toBeGreaterThan((await worker.boundingBox())!.x);
  const paletteKeys = await page.locator('.team-bubble .agent-name').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-agent-color')));
  expect(new Set(paletteKeys).size).toBe(5);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    const pairs = await page.locator('.team-bubble .agent-name').evaluateAll((elements) => elements.map((element) => ({
      color: getComputedStyle(element).color,
      background: getComputedStyle(element.closest('.team-bubble')!).backgroundColor,
    })));
    const luminance = (rgb: string) => {
      const channels = rgb.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((value) => value / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    for (const pair of pairs) {
      const a = luminance(pair.color), b = luminance(pair.background);
      expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
    expect(new Set(pairs.map((pair) => pair.color)).size).toBe(5);
    await expect(worker.locator('.agent-name')).toHaveCSS('color', theme === 'light' ? 'rgb(67, 56, 202)' : 'rgb(165, 180, 252)');
    await page.screenshot({ path: test.info().outputPath(`agent-colors-${theme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });

  for (const [bubble, text] of [[coordinator, 'Coordinator verification output'], [worker, 'Worker test output'], [senior, 'Senior audit reasoning']] as const) {
    await expect(bubble.locator('.log-pre')).toBeHidden();
    await bubble.getByText(/View details/).click();
    await expect(bubble.locator('.log-pre')).toContainText(text);
  }
  const orphan = page.getByRole('article', { name: 'Jordan · Auditor', exact: true });
  await orphan.getByText(/View details/).click();
  await expect(orphan.locator('.log-pre')).toContainText('No summary was recorded.');
  await expect(orphan.locator('.profile-context')).toContainText('Write acceptance scripts');
  await expect(page.getByRole('article', { name: 'Jamie · Designer', exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Jamie · Designer', exact: true }).locator('.team-details')).toHaveCount(0);
  await expect(page.getByText('No additional details recorded for this message.', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('team-chat.png') });
  await page.getByRole('combobox', { name: 'Filter by agent' }).selectOption('worker-5');
  await expect(page.locator('.team-bubble')).toHaveCount(1);
  await expect(worker).toBeVisible();

  await tabs.getByRole('tab', { name: /Thread/ }).click();
  const composer = page.locator('.composer');
  await expect(composer).not.toContainText('New development requests become Icebox cards');
  const message = page.getByRole('textbox', { name: 'Message coordinator' });
  await expect(message).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport();
  const before = await composer.boundingBox();
  await page.locator('.thread-history').evaluate((el) => { el.scrollTop = 0; });
  const after = await composer.boundingBox();
  expect(after!.y).toBeCloseTo(before!.y, 0);
  await expect(page.getByRole('region', { name: 'Deliverables', exact: true }).filter({ hasText: 'How to review' })).toBeVisible();
  await message.fill('**Review** #');
  await expect(page.getByRole('option', { name: /Referenced task/ })).toBeVisible();
  await page.getByRole('option', { name: /Referenced task/ }).click();
  await expect(message).toHaveValue('**Review** #900011 ');
  await composer.locator('input[type=file]').setInputFiles({ name: 'thread-review.png', mimeType: 'image/png', buffer: PNG });
  await expect(message).toHaveValue(/!\[thread-review\]\(\/uploads\/[\w-]+\.png\)/);
  await composer.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(composer.locator('strong')).toHaveText('Review');
  await expect(composer.getByRole('link', { name: '#900011', exact: true })).toBeVisible();
  await expect(composer.getByRole('img', { name: 'thread-review', exact: true })).toBeVisible();
  // The toolbar must still work when the textarea is unmounted in Preview.
  await composer.getByRole('button', { name: 'Tag', exact: true }).click();
  await expect(message).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: test.info().outputPath('sticky-thread-editor.png') });
});
