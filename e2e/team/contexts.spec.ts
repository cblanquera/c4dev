import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, expectNoHorizontalOverflow, test } from '../helpers.ts';

test.describe('Journey: giving agents more context', () => {
  test('an MCP server is added from pasted JSON, tested, switched off and on, attached to an agent and removed', async ({ page }) => {
    const name = `secrets-${test.info().project.name}`;
    const config = { mcpServers: { [name]: { type: 'stdio', command: process.execPath, args: [path.resolve('test/fixtures/mcp-server.mjs')], env: { SECRET_WORD: 'pelican-42' } } } };

    await page.goto('/#settings/contexts');
    const settings = page.getByRole('main');
    await expect(settings.getByRole('heading', { name: 'Contexts' })).toBeVisible();
    await settings.getByRole('button', { name: 'Add Context' }).click();
    const editor = page.getByRole('dialog', { name: 'Add context' });
    await editor.getByText('Paste a JSON config').click();
    await editor.getByLabel('MCP server JSON').fill(JSON.stringify(config));
    await editor.getByRole('button', { name: 'Fill in from JSON' }).click();
    await expect(editor.getByLabel('Name', { exact: true })).toHaveValue(name);
    await expect(editor.getByRole('group', { name: 'Transport' }).getByRole('button', { name: 'STDIO' })).toHaveAttribute('aria-pressed', 'true');
    await expect(editor.getByLabel('Command to launch')).toHaveValue(process.execPath);
    await expect(editor.getByLabel('Argument 1', { exact: true })).toHaveValue(path.resolve('test/fixtures/mcp-server.mjs'));
    await expect(editor.getByLabel('Key 1', { exact: true })).toHaveValue('SECRET_WORD');
    // The HTTP form has its own fields.
    await editor.getByRole('button', { name: 'Streamable HTTP' }).click();
    await expect(editor.getByLabel('Bearer token env var')).toBeVisible();
    await expect(editor.getByRole('region', { name: 'Headers from environment variables' })).toBeVisible();
    await editor.getByRole('button', { name: 'STDIO' }).click();
    await expectNoHorizontalOverflow(page);

    // Test connection saves it, then lists its tools.
    await editor.getByRole('button', { name: 'Test connection' }).click();
    await expect(editor.getByRole('status')).toContainText('Connected to test-secrets 1.0.0 · 1 tool: secret_word');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor).toHaveCount(0);

    const row = settings.getByRole('list', { name: 'Contexts' }).getByRole('listitem').filter({ hasText: name });
    await expect(row).toContainText('Not used by any agent');
    // Saved values are never shown again.
    await row.getByRole('button', { name: `Edit ${name}` }).click();
    const edit = page.getByRole('dialog', { name: 'Edit context' });
    await expect(edit.getByLabel('Value for SECRET_WORD')).toHaveValue('');
    await expect(edit.getByLabel('Value for SECRET_WORD')).toHaveAttribute('placeholder', 'Saved · type to replace');
    await edit.getByRole('button', { name: 'Cancel' }).click();

    // The switch turns it off everywhere without detaching it.
    const toggle = row.getByRole('switch', { name: `Use ${name}` });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(row).toContainText('off');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    // Agents attach contexts in their Contexts tab.
    await page.goto('/#settings/agents');
    await settings.getByRole('button', { name: 'Edit Jamie' }).click();
    const agent = page.getByRole('dialog', { name: 'Edit Jamie' });
    await agent.getByRole('tablist', { name: 'Agent sections' }).getByRole('tab', { name: 'Contexts' }).click();
    const search = agent.getByRole('searchbox', { name: 'Search contexts' });
    await search.fill('no-such-context');
    await expect(agent.getByRole('checkbox')).toHaveCount(0);
    await search.fill(name);
    await agent.getByRole('checkbox', { name: new RegExp(name) }).check();
    await expect(agent.getByRole('status')).toContainText('1 attached · 1 match');
    await agent.getByRole('button', { name: 'Save agent' }).click();
    await expect(settings.getByRole('button', { name: 'Edit Jamie' }).getByLabel('Contexts')).toContainText(name);

    // Deleting it (from its editor) detaches it.
    await page.goto('/#settings/contexts');
    await expect(row).toContainText('Used by Jamie');
    await row.getByRole('button', { name: `Edit ${name}` }).click();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('dialog', { name: 'Edit context' }).getByRole('button', { name: 'Delete' }).click();
    await expect(row).toHaveCount(0);
    await page.goto('/#settings/agents');
    await expect(settings.getByRole('button', { name: 'Edit Jamie' })).not.toContainText(name);
  });

  test('a local folder of Markdown knowledge is a context, checked for its entry document', async ({ page }) => {
    const name = `kb-${test.info().project.name}`;
    const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-e2e-kb-'));
    fs.mkdirSync(path.join(kb, 'context'));
    fs.writeFileSync(path.join(kb, 'CONTEXT.md'), '# Knowledge\n\n- [Product](context/product.md)\n');
    fs.writeFileSync(path.join(kb, 'context', 'product.md'), '# Product\n');
    try {
      await page.goto('/#settings/contexts');
      const settings = page.getByRole('main');
      await settings.getByRole('button', { name: 'Add Context' }).click();
      const editor = page.getByRole('dialog', { name: 'Add context' });
      await editor.getByLabel('Name', { exact: true }).fill(name);
      await editor.getByRole('group', { name: 'Transport' }).getByRole('button', { name: 'Local Folder' }).click();
      await expect(editor.getByText('Its tools only read')).toHaveCount(0);
      await editor.getByLabel('Folder', { exact: true }).fill(kb);
      await expectNoHorizontalOverflow(page);
      await editor.getByRole('button', { name: 'Test connection' }).click();
      await expect(editor.getByRole('status')).toContainText('Found CONTEXT.md · 2 Markdown files in the folder');
      await editor.getByRole('button', { name: 'Save' }).click();
      const row = settings.getByRole('list', { name: 'Contexts' }).getByRole('listitem').filter({ hasText: name });
      await expect(row).toContainText('folder');
      await row.getByRole('button', { name: `Edit ${name}` }).click();
      page.once('dialog', (dialog) => void dialog.accept());
      await page.getByRole('dialog', { name: 'Edit context' }).getByRole('button', { name: 'Delete' }).click();
      await expect(row).toHaveCount(0);
    } finally {
      fs.rmSync(kb, { recursive: true, force: true });
    }
  });
});
