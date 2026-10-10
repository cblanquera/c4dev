import { DEMO_BOARD, expect, expectNoHorizontalOverflow, test } from '../helpers.ts';

test.describe('Journey: keeping spend in check', () => {
  test('projects and agents get monthly budgets, and every run has limits', async ({ page, request }) => {
    // Factory-wide run limits.
    await page.goto('/#settings/limits');
    const settings = page.getByRole('main');
    await expect(settings.getByRole('heading', { name: 'Limits' })).toBeVisible();
    await settings.getByLabel('Max turns per run').fill('150');
    await settings.getByRole('button', { name: 'Save limits' }).click();
    await expect(settings.getByRole('status')).toContainText('Saved');
    expect((await (await request.get('/api/state')).json()).limits.maxTurns).toBe(150);
    await expectNoHorizontalOverflow(page);
    await request.patch('/api/limits', { data: { maxTurns: 200 } });

    // An agent's budget lives in its Usage tab; moving it off the simulation is confirmed first.
    await page.goto('/#settings/agents');
    await settings.getByRole('button', { name: 'Edit Sam' }).click();
    const editor = page.getByRole('dialog', { name: 'Edit Sam' });
    await editor.getByRole('tablist', { name: 'Agent sections' }).getByRole('tab', { name: 'Usage' }).click();
    await expect(editor.getByRole('status')).toContainText('This month:');
    await editor.getByLabel('Monthly token limit').fill('500000');
    await editor.getByRole('tablist', { name: 'Agent sections' }).getByRole('tab', { name: 'Profile' }).click();
    await editor.getByLabel('Provider').selectOption('claude');
    let asked = '';
    page.once('dialog', (dialog) => {
      asked = dialog.message();
      void dialog.dismiss();
    });
    await editor.getByRole('button', { name: 'Save agent' }).click();
    expect(asked).toMatch(/Sam will run on Claude.*may cost money.*500,000 tokens/);
    await expect(editor, 'declining keeps the editor open and nothing changes').toBeVisible();
    await editor.getByLabel('Provider').selectOption('simulated');
    await editor.getByRole('button', { name: 'Save agent' }).click();
    await expect(editor).toHaveCount(0);
    let sam = (await (await request.get('/api/state')).json()).profiles.find((p: { name: string }) => p.name === 'Sam');
    expect([sam.provider, sam.budgetTokens]).toEqual(['simulated', 500000]);

    // A project's budget lives in its Team settings.
    await page.goto(DEMO_BOARD);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const project = page.getByRole('dialog', { name: 'Project settings' });
    await project.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Team' }).click();
    const budget = project.getByRole('group', { name: 'Monthly budget' });
    await budget.getByLabel('Monthly spend limit (USD)').fill('25');
    await expect(budget.getByRole('status')).toContainText('of $25.00');
    await expectNoHorizontalOverflow(page);
    await project.getByRole('button', { name: 'Save settings' }).click();
    const demo = (await (await request.get('/api/state')).json()).projects.find((p: { id: number }) => p.id === 1);
    expect(demo.settings.budgetUsd).toBe(25);

    await request.patch('/api/projects/1', { data: { settings: { budgetUsd: 0 } } });
    sam = (await (await request.get('/api/state')).json()).profiles.find((p: { name: string }) => p.name === 'Sam');
    await request.patch(`/api/profiles/${sam.id}`, { data: { budgetTokens: 0 } });
  });
});
