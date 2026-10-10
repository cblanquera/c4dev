import { expect, test } from '../helpers.ts';
import type { Card, CardDetail, SubtaskStatus } from '../../server/types.ts';
import { expectNoHorizontalOverflow } from '../helpers.ts';

test('card tabs stay visible while switching and scrolling a long Activity log', async ({ page, request }) => {
  const state = await (await request.get('/api/state')).json();
  const now = Date.now();
  const card: Card = {
    id: 900001, projectId: 1, kind: 'task', title: 'Activity navigation fixture', description: '# Activity navigation\n\nInspect long logs.',
    instructions: 'Check every tab.', instructionsHash: 'current', instructionsCurrent: true,
    stage: 'complete', position: 0, status: 'idle', statusText: 'Complete', tags: [], parentId: 1,
    branch: 'factory/card-900001', worktree: null, loops: 1, coverage: 100, acceptanceReady: true,
    deliverableKind: null, resumeStage: null, secretNames: ['DEMO_KEY'], hidden: false,
    createdAt: now, updatedAt: now, stageChangedAt: now, completedAt: now,
  };
  const statuses: SubtaskStatus[] = ['pending', 'running', 'done', 'failed', 'blocked', 'aborted'];
  const detail: CardDetail = {
    card, comments: [], deliveryNotes: '', chatBusy: false, usage: { runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    subtasks: statuses.map((status, i) => ({
      id: i + 1, cardId: card.id, seq: i + 1, round: 1, kind: 'build', title: `${status} subtask`,
      instructions: 'Inspect status.', doneWhen: 'Status is visible.', dependsOn: [], status,
      worker: null, branch: null, worktree: null, summary: '', diff: '', files: [], attempts: 0,
      startedAt: null, endedAt: null,
    })),
    logs: Array.from({ length: 240 }, (_, i) => ({
      id: i + 1, cardId: card.id, subtaskId: null, actor: i % 2 ? 'worker-1' : 'coordinator',
      level: (['oneliner', 'summary', 'detail', 'diff'] as const)[i % 4],
      text: i % 4 === 3 ? `diff --git a/fixture-${i}.txt b/fixture-${i}.txt\n@@ -0,0 +1 @@\n+Activity entry ${i}` : `Activity entry ${i}: enough history to fill the panel.`,
      ts: now + i,
    })),
  };
  await page.route('**/api/state', (route) => route.fulfill({ json: { ...state, cards: [card] } }));
  await page.route(`**/api/cards/${card.id}`, (route) => route.fulfill({ json: detail }));
  await page.route('**/api/events', (route) => route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' }));
  await page.goto(`/#card-${card.id}`);
  const tabs = page.getByRole('tablist', { name: 'Card sections' });
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole('tab', { name: 'Subtasks', exact: true })).toBeVisible();
  await expect(page.locator('.column-hint')).toHaveCount(0);
  const section = (name: string) => tabs.getByRole('tab', { name, exact: true });
  await expect(section('Overview').locator('.dot-unread')).toHaveCount(0);
  await expect(section('Subtasks').locator('.dot-unread')).toHaveCount(1);
  await expect(section('Activity').locator('.dot-unread')).toHaveCount(1);
  await expect(section('Thread')).toHaveText('Thread');
  await expect(section('Thread').locator('.dot-unread')).toHaveCount(0); // Empty content is not unread.

  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await tabs.getByRole('tab', { name: 'Activity', exact: true }).click();
    for (const form of ['Logs', 'Team Chat', 'Diffs']) {
      await page.getByRole('tab', { name: new RegExp(form) }).click();
      await page.locator('.logview-body').evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await expect(tabs).toBeInViewport();
      const box = await tabs.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(40);
      for (const name of ['Overview', 'Subtasks', 'Activity', 'Thread']) {
        await expect(tabs.getByRole('tab', { name: new RegExp(name) })).toBeInViewport();
      }
    }
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: test.info().outputPath(`activity-${theme}.png`) });
    await tabs.getByRole('tab', { name: /Subtasks/ }).click();
    await expect(page.locator('.subtask-title > .mono')).toHaveText(['6', '5', '4', '3', '2', '1']);
    for (const status of statuses) await expect(page.getByRole('img', { name: status, exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`status-icons-${theme}.png`) });
    await tabs.getByRole('tab', { name: /Thread/ }).click();
    await expect(page.getByText('No conversation yet.')).toBeVisible();
    await tabs.getByRole('tab', { name: 'Overview', exact: true }).click();
    await expect(page.getByText('Inspect long logs.')).toBeVisible();
  }
  await expect(tabs.locator('.dot-unread')).toHaveCount(0);
  await page.reload();
  await expect(tabs.locator('.dot-unread')).toHaveCount(0); // Receipts survive reloads.

  // Changes to existing content count even when item counts do not change.
  detail.subtasks[0].title = 'Updated pending subtask';
  detail.logs[0].text = 'Updated activity output';
  detail.card.description = 'New overview content';
  detail.comments.push({ id: 1, cardId: card.id, author: 'coordinator', kind: 'reply', body: 'New reply', ts: now + 1000 });
  await page.reload();
  await expect(section('Overview').locator('.dot-unread')).toHaveCount(0);
  for (const name of ['Subtasks', 'Activity', 'Thread']) await expect(section(name).locator('.dot-unread')).toHaveCount(1);
  await expect(section('Thread')).toHaveText('Thread');
  await section('Thread').click();
  await expect(section('Thread').locator('.dot-unread')).toHaveCount(0);
  await expect(section('Subtasks').locator('.dot-unread')).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath('unread-tabs.png') });
  await section('Overview').click();
  await expect(section('Thread').locator('.dot-unread')).toHaveCount(0); // Switching away does not re-mark read content.
  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.getByRole('article', { name: /^Card 900001:/ }).click();
  await expect(section('Thread').locator('.dot-unread')).toHaveCount(0);
});

test('icon controls keep their accessible names and the board has no hints', async ({ page }) => {
  await page.goto('/#project-1');
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  await expect(settings.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('.column-hint')).toHaveCount(0);
  await settings.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'New card', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Close panel' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Image' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
