import { expect, test } from '../helpers.ts';
import { column, createCard } from '../helpers.ts';

test.describe('Journey: controlling work', () => {
  test('aborting a running card stops it and returns it to the Icebox, editable', async ({ page }) => {
    const id = await createCard(page, '# Long job\n\n- part one\n- part two\n- part three', { queue: true });
    await expect(column(page, 'In Progress').locator(`[data-card-id="${id}"]`)).toBeVisible({ timeout: 30_000 });
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: /Abort/ }).click();
    await expect(column(page, 'Icebox').locator(`[data-card-id="${id}"]`)).toBeVisible();
    await expect(page.locator(`[data-card-id="${id}"]`)).toContainText(/Aborted from/);
    await expect(page.getByRole('tab', { name: 'Write' })).toBeVisible();
  });

  test('completed cards can be hidden and shown again', async ({ page }) => {
    const id = await createCard(page, '# Tiny tweak\n\n- rename a variable\n- update its test', { queue: true });
    await expect(column(page, 'Complete').locator(`[data-card-id="${id}"]`)).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Hide' }).click();
    await page.getByRole('button', { name: 'Close panel' }).click();
    await expect(column(page, 'Complete').locator(`[data-card-id="${id}"]`)).toBeHidden();
    await column(page, 'Complete').getByRole('button', { name: /hidden or older/ }).click();
    await expect(column(page, 'Complete').locator(`[data-card-id="${id}"]`)).toBeVisible();
  });
});
