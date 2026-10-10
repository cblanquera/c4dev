import { expect, test } from '../helpers.ts';
import { expectNoHorizontalOverflow } from '../helpers.ts';

test('background process popover refreshes and stops only the selected project server', async ({ page }) => {
  let processes = [
    { id: 'fixture-preview', summary: 'Calendar preview', pid: 1234, url: 'http://localhost:3018', startedAt: '2026-10-08T08:00:00Z', stopsAt: '2026-10-08T10:00:00Z', currentServer: false },
    { id: 'fixture-api', summary: 'Factory API', pid: 1235, url: 'http://localhost:3019', startedAt: '2026-10-08T08:00:00Z', stopsAt: null, currentServer: true },
  ];
  const stopped: string[] = [];
  await page.route('**/api/processes', (route) => route.fulfill({ json: { processes } }));
  await page.route('**/api/processes/stop', async (route) => {
    const id = route.request().postDataJSON().id;
    stopped.push(id);
    processes = processes.filter((process) => process.id !== id);
    await route.fulfill({ json: { ok: true, disconnects: false } });
  });
  await page.goto('/#project-1');
  const trigger = page.getByRole('button', { name: 'Background processes', exact: true });
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  const triggerBox = await trigger.boundingBox();
  const settingsBox = await settings.boundingBox();
  expect(triggerBox!.x).toBeLessThan(settingsBox!.x);
  await trigger.click();
  const popover = page.getByRole('dialog', { name: 'Background processes' });
  await expect(popover).toContainText('Calendar preview');
  await expect(popover).toContainText('Factory API');
  await expect(popover).toContainText('Stopping this API disconnects the factory.');
  await popover.getByRole('button', { name: 'Stop Calendar preview', exact: true }).click();
  await expect(popover).not.toContainText('Calendar preview');
  await expect(popover).toContainText('Factory API');
  expect(stopped).toEqual(['fixture-preview']);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: test.info().outputPath('processes.png') });
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  processes = [];
  await popover.getByRole('button', { name: 'Refresh processes' }).click();
  await expect(popover).toContainText('No running background processes.');
  await popover.getByRole('button', { name: 'Close processes' }).click();
  await expect(popover).toHaveCount(0);
});
