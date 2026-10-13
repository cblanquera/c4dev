import { DEMO_BOARD, expect, expectNoHorizontalOverflow, test } from '../helpers.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test.describe('Journey: telling projects apart', () => {
  test('a project gets a logo by upload or link, shown on its board beside a way back home', async ({ page, request }) => {
    await page.goto(DEMO_BOARD);
    const header = page.locator('header.topbar');
    await expect(header.getByRole('img', { name: 'Software Factory' })).toBeVisible();

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Project settings' });
    await settings.getByLabel('Logo image').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
    await expect(settings.getByRole('img', { name: 'Demo project logo' })).toHaveAttribute('src', /^\/uploads\/.+\.png$/);
    await expect(settings.getByText('Using an uploaded image.')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await settings.getByRole('button', { name: 'Save settings' }).click();
    await expect(header.getByRole('img', { name: 'Demo project logo' })).toHaveAttribute('src', /^\/uploads\/.+\.png$/);

    // A link that doesn't load falls back to the factory's mark.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('textbox', { name: 'Logo' }).fill('http://127.0.0.1:9/missing.png');
    await settings.getByRole('button', { name: 'Save settings' }).click();
    await expect(header.getByRole('img', { name: 'Software Factory' })).toBeVisible();

    // The arrow goes back to the home screen, where the tile shows the logo too.
    await request.patch('/api/projects/1', { data: { settings: { logoUrl: (await (await request.post('/api/uploads', { headers: { 'content-type': 'image/png' }, data: PNG })).json()).url } } });
    await header.getByRole('link', { name: /^All projects/ }).click();
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Demo project logo' })).toBeVisible();
    await request.patch('/api/projects/1', { data: { settings: { logoUrl: '' } } });
  });
});
