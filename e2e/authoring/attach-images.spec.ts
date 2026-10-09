import { expect, test } from '@playwright/test';

// 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test.describe('Journey: authoring a card', () => {
  test('attaching an image uploads it and embeds it in the markdown', async ({ page }) => {
    await page.goto('/#new');
    const task = page.getByPlaceholder(/Describe the outcome/);
    await task.fill('# Fix the header\n\nSee screenshot:\n');
    await page.locator('input[type=file]').setInputFiles({ name: 'header-bug.png', mimeType: 'image/png', buffer: PNG });
    await expect(task).toHaveValue(/!\[header-bug\]\(\/uploads\/[\w-]+\.png\)/);
    await page.getByRole('tab', { name: 'Preview' }).click();
    const img = page.locator('.md-box img[alt="header-bug"]');
    await expect(img).toBeVisible();
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
  });
});
