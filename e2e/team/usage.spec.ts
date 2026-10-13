import { DEMO_BOARD, expect, expectNoHorizontalOverflow, test } from '../helpers.ts';

test.describe('Journey: seeing what the agents cost', () => {
  test('usage per day and per model, for every project and for one', async ({ page }) => {
    await page.goto('/#settings/usage');
    const settings = page.getByRole('main');
    await expect(settings.getByRole('heading', { name: 'Usage', exact: true })).toBeVisible();
    await expect(settings.getByText('Tokens today')).toBeVisible();
    await expect(settings.getByText('Last 7 days')).toBeVisible();

    // One column per day, each with its value for screen readers and a tooltip on focus.
    const days = settings.getByRole('list', { name: 'Tokens per day' }).getByRole('listitem');
    await expect(days).toHaveCount(7);
    await days.last().focus();
    await expect(settings.getByRole('status')).toContainText('tokens');
    await settings.getByRole('group', { name: 'Range' }).getByRole('button', { name: '30 days' }).click();
    await expect(days).toHaveCount(30);
    await settings.getByRole('group', { name: 'Chart shows' }).getByRole('button', { name: 'Cost' }).click();
    await expect(settings.getByRole('heading', { name: 'Estimated cost per day' })).toBeVisible();
    await expect(settings.getByRole('list', { name: 'Estimated cost per day' }).getByRole('listitem')).toHaveCount(30);

    // The same numbers as a table, and totals per model (simulated runs record model "simulated").
    await settings.getByText('Table view').click();
    await expect(settings.getByRole('row', { name: /^30 days/ })).toBeVisible();
    const models = settings.getByRole('table', { name: 'By model' });
    await expect(models.getByRole('row', { name: /simulated/ })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Each project's settings have the same view for that project.
    await page.goto(DEMO_BOARD);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const project = page.getByRole('dialog', { name: 'Project settings' });
    await project.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Usage' }).click();
    await expect(project.getByRole('list', { name: 'Tokens per day' }).getByRole('listitem')).toHaveCount(7);
    await expect(project.getByText('Estimated cost, 7 days')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
