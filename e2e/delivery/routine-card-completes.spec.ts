import { expect, test } from '../helpers.ts';
import { column, createCard, expectNoHorizontalOverflow, isMobile, tile } from '../helpers.ts';

test.describe('Journey: delivering a routine card', () => {
  test('a card dragged to the Backlog is built, verified, accepted and completed', async ({ page }) => {
    const id = await createCard(page, '# Clamp helper\n\n- clamp(n, min, max)\n- tests for clamp');
    await page.goto('/#project-1');

    if (isMobile(page)) {
      // Touch devices have no HTML5 drag; the panel offers the same move.
      await page.goto(`/#card-${id}`);
      await page.getByRole('button', { name: /Move to Backlog/ }).click();
    } else {
      await tile(page, id).dragTo(column(page, 'Backlog').locator('.column-body'));
    }

    // The card is no longer editable once it leaves the Icebox.
    await page.goto(`/#card-${id}`);
    await expect(page.getByRole('tab', { name: /Subtasks/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Write' })).toHaveCount(0);

    await expect(column(page, 'In Progress').locator(`[data-card-id="${id}"]`).or(column(page, 'Verification').locator(`[data-card-id="${id}"]`))).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('in-flight.png') });
    await expect(column(page, 'Complete').locator(`[data-card-id="${id}"]`)).toBeVisible({ timeout: 60_000 });
    // The demo project keeps branches, so the tile and Overview say the work isn't merged yet.
    await expect(tile(page, id).getByRole('img', { name: 'Not merged' })).toBeVisible();
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    await expect(page.getByText(`Not merged · Kept on factory/card-${id}`)).toBeVisible();

    // Merging queues a merge card, marked as the factory's own; the finished card stays in Complete.
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Merge into main' }).click();
    await expect(page).not.toHaveURL(new RegExp(`#card-${id}$`));
    const merge = Number(page.url().match(/#card-(\d+)$/)![1]);
    await expect(tile(page, id).getByRole('img', { name: 'Merged' })).toBeVisible();
    await expect(column(page, 'Complete').locator(`[data-card-id="${merge}"]`).locator('[data-kind="merge"]')).toBeVisible();
    await page.goto(`/#card-${id}`);
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    await expect(page.getByText(`Merged into main by #${merge}`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Merge into main' })).toHaveCount(0);

    // Subtasks show the plan, the audit rework round and the acceptance scripts.
    await page.getByRole('tab', { name: /Subtasks/ }).click();
    await expect(page.getByRole('heading', { name: /^Plan/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Rework 1/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Acceptance scripts/ })).toBeVisible();

    // Each subtask has the four log forms, including a real diff.
    await page.getByRole('button', { name: /clamp\(n, min, max\)/ }).click();
    for (const form of ['Logs', 'Team Chat', 'Diffs']) await expect(page.getByRole('tab', { name: new RegExp(form) }).first()).toBeVisible();
    await page.getByRole('tab', { name: /Diffs/ }).first().click();
    await expect(page.locator('.diff-file .path').first()).toContainText(`factory-sim/card-${id}/`);
    await expect(page.locator('.l-add').first()).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('complete.png') });
    await expectNoHorizontalOverflow(page);
  });

  test('cards outside the Icebox and Backlog cannot be dragged', async ({ page }) => {
    test.skip(isMobile(page), 'drag & drop is a pointer interaction');
    await page.goto('/#project-1');
    const done = column(page, 'Complete').locator('article').first();
    await expect(done).toBeVisible({ timeout: 60_000 });
    await expect(done).toHaveAttribute('draggable', 'false');
  });
});
