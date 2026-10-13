import { expect, expectNoHorizontalOverflow, test } from '../helpers.ts';

test.describe('Journey: adding Jev to make decisions cheaper', () => {
  test('Jev is added with an API key, switched off and on, catches a vague task, and is removed', async ({ page }) => {
    await page.goto('/#settings/providers');
    const settings = page.getByRole('main');
    const row = settings.getByRole('listitem', { name: 'Jev' });
    await expect(row).toContainText('Not added');
    await expect(row.getByRole('switch')).toHaveCount(0);

    await row.getByRole('button', { name: 'Add' }).click();
    const add = page.getByRole('dialog', { name: 'Add Jev' });
    await expect(add.getByRole('button', { name: 'Save' })).toBeDisabled();
    await add.getByLabel('API key').fill('wrong-key');
    await add.getByRole('button', { name: 'Save' }).click();
    await expect(add.getByRole('alert')).toHaveText('TypeSafe refused that API key');
    await add.getByLabel('API key').fill('test-jev-key');
    await add.getByRole('button', { name: 'Save' }).click();
    await expect(add).toHaveCount(0);

    // Added: a settings button and a switch replace Add.
    await expect(row).toContainText('On · jev-latest');
    const toggle = row.getByRole('switch', { name: 'Use Jev' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(row).toContainText('Off · jev-latest');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expectNoHorizontalOverflow(page);

    // With Jev on, a task too vague to work from is sent back before instructions are written; it can still go ahead.
    await page.goto('/#project-1/new');
    await page.getByPlaceholder(/Describe the outcome/).fill(`VAGUE-E2E ${test.info().project.name}`);
    await page.getByRole('button', { name: /Generate instructions/ }).click();
    const notice = page.getByRole('status').filter({ hasText: 'too brief' });
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: 'Generate anyway' }).click();
    await expect(page.getByRole('heading', { name: 'Open questions' })).toBeVisible();

    // Settings updates or removes it; the key is never shown again.
    await page.goto('/#settings/providers');
    await row.getByRole('button', { name: 'Jev settings' }).click();
    const edit = page.getByRole('dialog', { name: 'Jev settings' });
    await expect(edit.getByLabel('API key')).toHaveValue('');
    await expect(edit.getByLabel('API key')).toHaveAttribute('placeholder', 'Saved · type to replace');
    page.once('dialog', (dialog) => void dialog.accept());
    await edit.getByRole('button', { name: 'Remove' }).click();
    await expect(row).toContainText('Not added');
    await expect(row.getByRole('button', { name: 'Add' })).toBeVisible();
  });
});
