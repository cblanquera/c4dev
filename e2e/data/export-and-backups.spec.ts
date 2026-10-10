import fs from 'node:fs';
import { expect, expectNoHorizontalOverflow, test } from '../helpers.ts';

test.describe('Journey: keeping the setup safe', () => {
  test('the setup exports to a file that imports back, and backups are taken on request', async ({ page }) => {
    await page.goto('/#settings/data');
    const settings = page.getByRole('main');
    await expect(settings.getByRole('heading', { name: 'Data' })).toBeVisible();
    await expect(settings).toContainText('secret.key');

    const download = page.waitForEvent('download');
    await settings.getByRole('button', { name: 'Export setup' }).click();
    const file = await (await download).path();
    const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(exported.format).toBe('c4dev-export');
    expect(exported.agents.map((a: { name: string }) => a.name)).toContain('Ada Lovelace');

    await settings.getByLabel('Export file').setInputFiles(file);
    await expect(settings.getByRole('status')).toContainText('Updated');
    await expect(settings.getByRole('status')).toContainText('agent Ada Lovelace');

    const backups = settings.getByRole('list', { name: 'Backups' });
    const before = await backups.getByRole('listitem').filter({ hasText: '-manual.db' }).count();
    await settings.getByRole('button', { name: 'Back up now' }).click();
    await expect(backups.getByRole('listitem').filter({ hasText: '-manual.db' })).toHaveCount(Math.min(before + 1, 10));
    await expectNoHorizontalOverflow(page);
  });
});
