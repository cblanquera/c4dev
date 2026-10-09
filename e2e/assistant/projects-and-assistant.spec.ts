import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { column, expectNoHorizontalOverflow } from '../helpers.ts';

const conversation = (page: Page) => page.getByRole('log', { name: 'Assistant conversation' });

async function ask(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message assistant' }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.describe('Journey: one assistant for every project', () => {
  test('home lists projects beside the assistant and opens their boards', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await expect(conversation(page)).toBeVisible();
    // Only the last two folders of the repository are shown; the full path can be copied.
    const tile = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Demo project board' }) });
    await expect(tile.getByText(/^…\/[^/]+\/demo-repo$/)).toBeVisible();
    await expect(tile.getByRole('button', { name: 'Copy repository path' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByRole('link', { name: 'Demo project board' }).click();
    await expect(page).toHaveURL(/#project-1$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Demo project' })).toBeVisible();
    await expect(column(page, 'Icebox')).toBeVisible();
    await page.getByRole('link', { name: /^All projects/ }).click();
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
  });

  test('a new project needs its own git repository', async ({ page }) => {
    const name = `Shop ${test.info().project.name}`;
    // Its own parent folder, so the folder browser lists only it.
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-e2e-shop-'));
    const repo = path.join(parentDir, 'shop');
    fs.mkdirSync(repo);
    try {
      await page.goto('/');
      await page.getByRole('button', { name: 'New project' }).click();
      const dialog = page.getByRole('dialog', { name: 'New project' });
      // Settings are split into sections with a menu.
      const sections = dialog.getByRole('tablist', { name: 'Settings sections' });
      await expect(sections.getByRole('tab')).toHaveText(['Project', 'Team', 'Quality gates']);
      await sections.getByRole('tab', { name: 'Team' }).click();
      await expect(dialog.getByLabel('Cards in flight')).toBeVisible();
      await expect(dialog.getByLabel('Name')).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'Create project' })).toBeDisabled();
      await expectNoHorizontalOverflow(page);
      await sections.getByRole('tab', { name: 'Project' }).click();
      await dialog.getByLabel('Name').fill(name);
      // The folder browser lists folders by name and marks git repositories.
      const choose = async () => {
        await dialog.getByRole('button', { name: 'Choose…' }).click();
        const picker = page.getByRole('dialog', { name: 'Choose a folder' });
        await picker.getByLabel('Folder path').fill(path.dirname(repo));
        await picker.getByLabel('Folder path').press('Enter');
        await picker.getByRole('list', { name: 'Folders' }).getByRole('button', { name: new RegExp(`^${path.basename(repo)}`) }).click();
        await expect(picker.getByLabel('Folder path')).toHaveValue(repo);
        return picker;
      };
      let picker = await choose();
      await expect(picker).not.toContainText('This folder is a git repository');
      await picker.getByRole('button', { name: 'Use this folder' }).click();
      await expect(dialog.getByLabel('Project path')).toHaveValue(repo);
      await dialog.getByRole('button', { name: 'Create project' }).click();
      await expect(page.getByRole('alert')).toContainText('Not a git repository');

      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      picker = await choose();
      await expect(picker).toContainText('This folder is a git repository');
      await expectNoHorizontalOverflow(page);
      await picker.getByRole('button', { name: 'Use this folder' }).click();
      await dialog.getByRole('button', { name: 'Create project' }).click();
      await expect(page).toHaveURL(/#project-\d+$/);
      await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
      await page.getByRole('link', { name: /^All projects/ }).click();
      await expect(page.getByRole('listitem').filter({ has: page.getByRole('link', { name: `${name} board` }) })).toContainText('No cards yet');
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  });

  test('the assistant drafts a card for confirmation, shows it over the chat and queues it when asked', async ({ page }) => {
    const title = `Gift tags ${test.info().project.name}`;
    await page.goto('/');
    await ask(page, `Create a card in Demo project: # ${title}\n\n- tag text\n- tag tests`);

    const confirmation = conversation(page).locator('.bubble').filter({ hasText: 'Here is how the agents read' }).filter({ hasText: title });
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByText('Full instructions')).toBeVisible();
    const chip = confirmation.getByRole('button', { name: new RegExp(`^Open card \\d+: ${title}$`) });
    const id = Number((await chip.getAttribute('aria-label'))!.match(/card (\d+)/)![1]);
    await expect(chip).toContainText('Icebox');
    await expect(chip).toContainText('Demo project');
    await page.screenshot({ path: test.info().outputPath('assistant-confirmation.png') });
    await expectNoHorizontalOverflow(page);

    // The card opens over the conversation, with the board's own controls.
    await chip.click();
    await expect(page).toHaveURL(new RegExp(`#chat/card-${id}$`));
    const panel = page.getByRole('complementary', { name: 'Card details' });
    await expect(panel.getByRole('button', { name: /Move to Backlog/ })).toBeEnabled();
    await panel.getByRole('button', { name: 'Close panel' }).click();
    expect(new URL(page.url()).hash).toBe('');

    await ask(page, `Move #${id} to the backlog`);
    await expect(conversation(page).getByText(`Moved #${id} to the Backlog`)).toBeVisible();
    const done = conversation(page).locator('.bubble.k-notification').filter({ hasText: `#${id} ${title} is complete in Demo project` });
    await expect(done).toBeVisible({ timeout: 60_000 });

    // Asking to see a card answers with a clickable card that opens its details.
    await ask(page, 'Show me the last card done');
    const shown = conversation(page).locator('.bubble.k-message').filter({ hasText: `The last card completed: #${id}` });
    await shown.getByRole('button', { name: new RegExp(`^Open card ${id}:`) }).click();
    await expect(page).toHaveURL(new RegExp(`#chat/card-${id}$`));
    await expect(panel.getByRole('tab', { name: 'Thread' })).toBeVisible();
    await page.getByRole('button', { name: 'Open board' }).click();
    await expect(page).toHaveURL(new RegExp(`#card-${id}$`));
    await expect(column(page, 'Complete').locator(`[data-card-id="${id}"]`)).toBeVisible();
  });

  test('a quick ask summarises every project at a high level', async ({ page }) => {
    await page.goto('/');
    const before = await conversation(page).locator('.bubble.from-assistant.k-message').count();
    await page.getByRole('button', { name: 'Status', exact: true }).click();
    const replies = conversation(page).locator('.bubble.from-assistant.k-message');
    await expect(replies).toHaveCount(before + 1);
    await expect(replies.last()).toContainText('Demo project');
    await expectNoHorizontalOverflow(page);
  });
});
