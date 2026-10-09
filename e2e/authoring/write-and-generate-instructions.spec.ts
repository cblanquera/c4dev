import { expect, test } from '@playwright/test';
import { createCard, column, expectNoHorizontalOverflow, tile } from '../helpers.ts';

test.describe('Journey: authoring a card', () => {
  test('instructions are generated, go stale when the task changes, and the card saves to the Icebox', async ({ page }) => {
    await page.goto('/#new');
    const task = page.getByPlaceholder(/Describe the outcome/);
    await task.fill('# Greeting helper\n\n- greet(name) returns "Hello, name"\n- tests for greet');
    await page.getByRole('button', { name: /Generate instructions/ }).click();
    await expect(page.getByRole('heading', { name: 'Acceptance criteria' })).toBeVisible();
    await expect(page.locator('.instructions-doc')).toContainText('greet(name) returns');
    await page.screenshot({ path: test.info().outputPath('generated.png') });

    // Changing the task makes the instructions stale until regenerated or kept.
    await task.fill('# Greeting helper\n\n- greet(name) returns "Hi, name"\n- tests for greet');
    await expect(page.getByText('The task changed since these instructions were generated.')).toBeVisible();
    await page.getByRole('button', { name: 'Regenerate' }).first().click();
    await expect(page.locator('.instructions-doc')).toContainText('Hi, name');
    await expect(page.getByText('The task changed')).toBeHidden();

    await page.getByRole('button', { name: 'Create in Icebox' }).click();
    await expect(page).toHaveURL(/#card-\d+$/);
    const id = Number(page.url().match(/(\d+)$/)![1]);
    await expect(column(page, 'Icebox').and(page.locator('section')).locator(`[data-card-id="${id}"]`)).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('a vague task gets open questions back', async ({ page }) => {
    await page.goto('/#new');
    await page.getByPlaceholder(/Describe the outcome/).fill('Make it faster');
    await page.getByRole('button', { name: /Generate instructions/ }).click();
    await expect(page.locator('.instructions-doc')).toContainText('The description is brief');
  });

  test('typing # suggests other cards and inserts a reference', async ({ page }) => {
    const topic = `Payment research ${test.info().project.name}`;
    const target = await createCard(page, `# ${topic}\n\n- compare providers\n- write summary`);
    await page.goto('/#new');
    const task = page.getByPlaceholder(/Describe the outcome/);
    await task.fill('Builds on #');
    await task.press('End');
    await task.pressSequentially('Paym');
    const option = page.getByRole('option', { name: new RegExp(topic) });
    await expect(option).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(task).toHaveValue(`Builds on #${target} `);
    await page.getByRole('tab', { name: 'Preview' }).click();
    await page.locator('.md-box a.card-ref', { hasText: `#${target}` }).click();
    await expect(page).toHaveURL(new RegExp(`#card-${target}$`));
    await expect(tile(page, target)).toBeVisible();
  });
});

test.describe('Journey: capturing an idea quickly', () => {
  test('a card can be created with just a title and fleshed out later', async ({ page }) => {
    await page.goto('/#new');
    await page.getByPlaceholder(/Describe the outcome/).fill('# Rate limiting for the public API');
    await expect(page.getByRole('button', { name: /Move to Backlog/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Create in Icebox' }).click();
    await expect(page).toHaveURL(/#card-\d+$/);
    const id = Number(page.url().match(/(\d+)$/)![1]);

    // It lands in the Icebox, still editable, and can't be queued until it has instructions.
    await expect(page.getByRole('region', { name: 'Icebox', exact: true }).locator(`[data-card-id="${id}"]`)).toContainText('No agent instructions yet');
    await expect(page.getByRole('button', { name: /Move to Backlog/ })).toBeDisabled();
    await expect(page.getByText('Generate instructions before the Backlog')).toBeVisible();

    // Later: add details, generate, save, then queue.
    await page.getByPlaceholder(/Describe the outcome/).fill('# Rate limiting for the public API\n\n- 100 requests per minute per key\n- 429 with Retry-After');
    await expect(page.getByText('Unsaved changes')).toBeVisible();
    await page.getByRole('button', { name: /Generate instructions/ }).click();
    await expect(page.getByRole('heading', { name: 'Acceptance criteria' })).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: /Move to Backlog/ })).toBeEnabled();
  });
});
