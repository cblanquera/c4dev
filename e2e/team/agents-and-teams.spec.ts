import { expect, test } from '../helpers.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEMO_BOARD, column, createCard, expectNoHorizontalOverflow, tile } from '../helpers.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test.describe('Journey: choosing the team', () => {
  test('an agent gets a picture, a brief and a skill, and joins a project team', async ({ page, request }) => {
    const suffix = test.info().project.name;
    const name = `Margaret ${suffix}`;
    const skill = `release-notes-${suffix}`;
    // Skills come into the library from a folder: every SKILL.md inside, with the files beside it.
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-e2e-skills-'));
    const skillDir = path.join(folder, 'skills', skill);
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${skill}\ndescription: Write release notes for every change.\n---\n# Release notes\n`);
    fs.writeFileSync(path.join(skillDir, 'scripts', 'changes.sh'), 'git log --oneline\n');
    fs.mkdirSync(path.join(folder, 'node_modules', 'ignored'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'node_modules', 'ignored', 'SKILL.md'), '---\nname: ignored\n---\n');

    // Settings is a page of its own, with an address per section.
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(/#settings$/);
    const settings = page.getByRole('main');
    const menu = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(settings.getByRole('heading', { name: 'Agents' })).toBeVisible();
    await expect(menu.getByRole('link')).toHaveText(['Back to App', 'Agents', 'Skills', 'Contexts', 'Providers', 'Usage', 'Limits', 'Data']);
    await menu.getByRole('link', { name: 'Skills' }).click();
    await expect(page).toHaveURL(/#settings\/skills$/);
    await settings.getByRole('button', { name: 'Add skills' }).click();
    const adding = page.getByRole('dialog', { name: 'Add skills' });
    const sources = adding.getByRole('tablist', { name: 'Skill sources' });
    await expect(sources.getByRole('tab')).toHaveText(['Local', 'GitHub', 'Skills.sh']);
    await adding.getByLabel('Skills folder').setInputFiles(folder);
    await expect(adding.getByRole('status')).toContainText(`Added ${skill}`);
    await sources.getByRole('tab', { name: 'GitHub' }).click();
    await expect(adding.getByLabel('Repository link')).toHaveAttribute('placeholder', 'https://github.com/owner/repo');
    await sources.getByRole('tab', { name: 'Skills.sh' }).click();
    await expect(adding.getByLabel('Skill link')).toHaveAttribute('placeholder', 'https://skills.sh/owner/repo/skill');
    await expectNoHorizontalOverflow(page);
    await adding.getByRole('button', { name: 'Done' }).click();
    const library = settings.getByRole('list', { name: 'Skills library' });
    await expect(library.getByRole('listitem').filter({ hasText: skill })).toContainText('2 files');
    await expect(library).not.toContainText('ignored');
    fs.rmSync(folder, { recursive: true, force: true });

    // Providers: every agent CLI, with whether it's installed and a switch.
    await menu.getByRole('link', { name: 'Providers' }).click();
    const list = settings.getByRole('list', { name: 'Providers' });
    await expect(list.getByRole('listitem')).toHaveCount(5);
    for (const name of ['Claude', 'Codex', 'OpenCode', 'Pi']) await expect(list.getByRole('switch', { name: `Use ${name}` })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Agents live beside the skills library. The Chief of Staff, who runs the assistant, comes first.
    await menu.getByRole('link', { name: 'Agents' }).click();
    await expect(page).toHaveURL(/#settings\/agents$/);
    await expect(menu.getByRole('link', { name: 'Back to App' })).toBeVisible();
    await expect(settings.getByRole('region').first()).toHaveAccessibleName('Chief of Staff');
    for (const group of ['Coordinators', 'Workers', 'Auditors', 'Architects']) {
      await expect(settings.getByRole('region', { name: group })).toBeVisible();
    }
    const chief = settings.getByRole('region', { name: 'Chief of Staff' }).getByRole('button', { name: 'Edit Ada Lovelace' });
    await expect(chief).toContainText('Assistant');
    await chief.click();
    const ada = page.getByRole('dialog', { name: 'Edit Ada Lovelace' });
    await expect(ada.getByLabel('Role')).toBeDisabled();
    await expect(ada.getByLabel('Role')).toHaveValue('assistant');
    await expect(ada.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    await ada.getByRole('button', { name: 'Cancel' }).click();
    await expect(settings.getByRole('region', { name: 'Workers' }).getByRole('button', { name: 'Edit Casey' })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Edit Linus Torvalds' })).toContainText('Architect');

    await settings.getByRole('button', { name: 'New agent' }).click();
    const dialog = page.getByRole('dialog', { name: 'New agent' });
    await dialog.getByLabel('Name').fill(name);
    await expect(dialog.getByLabel('Role').locator('option')).toHaveText(['Coordinator', 'Worker', 'Auditor', 'Architect']);
    await dialog.getByLabel('Role').selectOption('developer');
    await expect(dialog.getByLabel('Job title')).toHaveAttribute('placeholder', 'Worker');
    await dialog.getByLabel('Job title').fill('Flight Software Engineer');
    // Every agent chooses its provider and model; models are suggested in a dropdown under the field.
    await expect(dialog.getByLabel('Provider')).toHaveValue('simulated');
    await expect(dialog.getByRole('combobox', { name: 'Model' })).toBeDisabled();
    await dialog.getByLabel('Provider').selectOption('claude');
    const model = dialog.getByRole('combobox', { name: 'Model' });
    await model.click();
    const models = page.getByRole('listbox', { name: 'Models' });
    await expect(models.getByRole('option', { name: 'claude-opus-5-5' })).toBeVisible();
    const field = await model.boundingBox();
    const dropdown = await models.boundingBox();
    expect(Math.abs(dropdown!.y - (field!.y + field!.height))).toBeLessThan(10);
    expect(Math.abs(dropdown!.x - field!.x)).toBeLessThan(2);
    await model.fill('son');
    await expect(models.getByRole('option')).toHaveText(['claude-sonnet-5-5']);
    await model.press('ArrowDown');
    await model.press('Enter');
    await expect(model).toHaveValue('claude-sonnet-5-5');
    await expect(models).toHaveCount(0);
    // Back to Simulated so this test never calls a real provider.
    await dialog.getByLabel('Provider').selectOption('simulated');
    await expect(model).toHaveValue('');
    await dialog.getByLabel('Picture').setInputFiles({ name: 'margaret.png', mimeType: 'image/png', buffer: PNG });
    await expect(dialog.locator('img.avatar').first()).toBeVisible();
    const sections = dialog.getByRole('tablist', { name: 'Agent sections' });
    await sections.getByRole('tab', { name: 'Brief' }).click();
    await dialog.getByRole('textbox', { name: 'Brief' }).fill('Write defensive code and explain trade-offs.');
    // Agents choose from the library, with search.
    await sections.getByRole('tab', { name: 'Skills' }).click();
    const search = dialog.getByRole('searchbox', { name: 'Search skills' });
    await search.fill('no-such-skill');
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    await search.fill(skill);
    await dialog.getByRole('checkbox', { name: new RegExp(skill) }).check();
    await expect(dialog.getByRole('status')).toContainText('1 attached');
    await expectNoHorizontalOverflow(page);
    await dialog.getByRole('button', { name: 'Create agent' }).click();
    const agent = settings.getByRole('button', { name: `Edit ${name}` });
    await expect(agent).toContainText(skill);
    await expect(agent).toContainText('Flight Software Engineer (Worker)');
    await expect(agent.locator('img.avatar')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('agents.png') });
    await expectNoHorizontalOverflow(page);

    await menu.getByRole('link', { name: 'Back to App' }).click();
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');

    // Teams are chosen per project; an agent can work on several.
    await page.goto(DEMO_BOARD);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const project = page.getByRole('dialog', { name: 'Project settings' });
    await project.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Team' }).click();
    await expect(project).toContainText('Every agent can work on this project');
    await expect(project.getByRole('group', { name: 'Workers' })).toContainText('Casey');
    await project.getByRole('checkbox', { name: new RegExp(name) }).check();
    await project.getByRole('button', { name: 'Save settings' }).click();
    const state = await (await request.get('/api/state')).json();
    const profile = state.profiles.find((p: { name: string }) => p.name === name);
    expect(state.projects.find((p: { id: number }) => p.id === 1).settings.team).toEqual([profile.id]);
    await request.patch('/api/projects/1', { data: { settings: { team: [] } } });
  });

  test('copying an agent opens a new agent form filled in from it', async ({ page }) => {
    const name = `Casey copy ${test.info().project.name}`;
    await page.goto('/#settings/agents');
    const settings = page.getByRole('main');
    await settings.getByRole('button', { name: 'Edit Casey' }).click();
    await page.getByRole('dialog', { name: 'Edit Casey' }).getByRole('button', { name: 'Copy agent' }).click();
    const copy = page.getByRole('dialog', { name: 'New agent' });
    await expect(copy.getByLabel('Name')).toHaveValue('Casey (copy)');
    await expect(copy.getByLabel('Role')).toHaveValue('developer');
    await expect(copy.getByLabel('Job title')).toHaveValue('Designer');
    await copy.getByRole('tablist', { name: 'Agent sections' }).getByRole('tab', { name: 'Brief' }).click();
    await expect(copy.getByRole('textbox', { name: 'Brief' })).toHaveValue(/accessible contrast/);
    await copy.getByRole('tablist', { name: 'Agent sections' }).getByRole('tab', { name: 'Profile' }).click();
    await copy.getByLabel('Name').fill(name);
    await copy.getByRole('button', { name: 'Create agent' }).click();
    const tile = settings.getByRole('button', { name: `Edit ${name}` });
    await expect(tile).toContainText('Designer (Worker)');
    await expect(settings.getByRole('button', { name: 'Edit Casey', exact: true })).toBeVisible();

    // The Chief of Staff is one of a kind, so it has no copy.
    await settings.getByRole('button', { name: 'Edit Ada Lovelace' }).click();
    await expect(page.getByRole('dialog', { name: 'Edit Ada Lovelace' }).getByRole('button', { name: 'Copy agent' })).toHaveCount(0);
    await page.getByRole('dialog', { name: 'Edit Ada Lovelace' }).getByRole('button', { name: 'Cancel' }).click();

    await tile.click();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('dialog', { name: `Edit ${name}` }).getByRole('button', { name: 'Delete' }).click();
    await expect(tile).toHaveCount(0);
  });

  test('the board filters cards by type, and integration cards look different', async ({ page, request }) => {
    const id = await createCard(page, `# Filter me ${test.info().project.name}\n\n- one\n- two`, { queue: true });
    await expect(column(page, 'Complete').locator(`[data-card-id="${id}"]`)).toBeVisible({ timeout: 60_000 });
    const merge = await (await request.post(`/api/cards/${id}/merge`)).json();
    await page.goto(DEMO_BOARD);
    const mergeTile = tile(page, merge.id);
    await expect(mergeTile).toHaveAttribute('data-kind', 'merge');
    await expect(mergeTile).toContainText('Merge');
    await expect(mergeTile).toHaveAttribute('draggable', 'false');

    const filters = page.getByRole('group', { name: 'Card types' });
    await filters.getByRole('button', { name: /Merges/ }).click();
    await expect(filters.getByRole('button', { name: /Merges/ })).toHaveAttribute('aria-pressed', 'false');
    await expect(mergeTile).toHaveCount(0);
    await expect(tile(page, id)).toBeVisible();
    await filters.getByRole('button', { name: /Tasks/ }).click();
    await expect(tile(page, id)).toHaveCount(0);
    await page.reload();
    await expect(tile(page, id)).toHaveCount(0);
    await filters.getByRole('button', { name: /Tasks/ }).click();
    await filters.getByRole('button', { name: /Merges/ }).click();
    await expect(tile(page, merge.id)).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
