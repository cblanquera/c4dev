import { expect, type Page } from '@playwright/test';

export const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1000) < 760;

/** The demo project every fresh factory starts with. */
export const DEMO_BOARD = '/#project-1';

/** Writes a task, generates instructions and creates the card (always in the Icebox); optionally queues it. */
export async function createCard(page: Page, description: string, opts: { queue?: boolean } = {}): Promise<number> {
  await page.goto('/#project-1/new');
  await page.getByPlaceholder(/Describe the outcome/).fill(description);
  await page.getByRole('button', { name: /Generate instructions/ }).click();
  await expect(page.getByRole('heading', { name: 'Open questions' })).toBeVisible();
  await page.getByRole('button', { name: 'Create in Icebox' }).click();
  await expect(page).toHaveURL(/#card-\d+$/);
  const id = Number(page.url().match(/#card-(\d+)$/)![1]);
  await expect(page.locator(`[data-card-id="${id}"]`)).toBeVisible();
  if (opts.queue) await page.getByRole('button', { name: /Move to Backlog/ }).click();
  return id;
}

export const column = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
export const tile = (page: Page, id: number) => page.getByRole('article', { name: new RegExp(`^Card ${id}:`) });

/** No sideways page scroll: the layout fits the viewport. */
export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}
