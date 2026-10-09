import { expect, test } from '@playwright/test';
import { column } from '../helpers.ts';
import { createCard } from '../helpers.ts';

test.describe('Journey: a card that needs a human', () => {
  test('workers pause for a credential, resume with it, then wait for approval', async ({ page }) => {
    const id = await createCard(page, '# Import invoices\n\nFetch invoices with the BILLING_API_KEY every hour.', { queue: true });
    await expect(column(page, 'Deliverables').locator(`[data-card-id="${id}"]`)).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(`[data-card-id="${id}"] .badge`, { hasText: 'Needs input' })).toBeVisible();

    await page.goto(`/#card-${id}`);
    await expect(page.getByRole('tab', { name: /Thread/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.thread')).toContainText('BILLING_API_KEY');

    // Vague input gets pushed back instead of acted on.
    await page.getByPlaceholder(/Answer the question/).fill('ok');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.bubble.from-coordinator').last()).toContainText('say a bit more');

    // The secret field was suggested from the coordinator's question.
    await expect(page.getByPlaceholder('NAME')).toHaveValue('BILLING_API_KEY');
    await page.getByPlaceholder('secret value').fill('sk-live-123');
    await page.getByRole('button', { name: /Resume/ }).click();
    await expect(page.locator('.thread')).toContainText('Provided secret(s): BILLING_API_KEY');
    await expect(page.locator('.thread')).not.toContainText('sk-live-123');

    await expect(page.getByRole('button', { name: /Approve/ })).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: test.info().outputPath('awaiting-approval.png') });
    await page.getByRole('button', { name: /Approve/ }).click();
    await expect(column(page, 'Complete').locator(`[data-card-id="${id}"]`)).toBeVisible();

    // A follow-up card references the completed one.
    await page.getByRole('button', { name: /Follow-up card/ }).click();
    await expect(page.getByPlaceholder(/Describe the outcome/)).toHaveValue(new RegExp(`^Follow-up to #${id}`));
  });

  test('requesting changes sends an approved-for-review card back to work', async ({ page }) => {
    const id = await createCard(page, '# Pricing page copy\n\n- new headline\n- needs review before publishing', { queue: true });
    await page.goto(`/#card-${id}`);
    await expect(page.getByRole('button', { name: /Approve/ })).toBeVisible({ timeout: 60_000 });
    await page.getByPlaceholder(/Ask a question/).fill('Use a shorter headline, under six words.');
    await page.getByRole('button', { name: 'Request changes' }).click();
    await expect(page.locator('.stage-pill')).not.toHaveText('Deliverables');
    await page.getByRole('tab', { name: /Subtasks/ }).click();
    await expect(page.getByRole('button', { name: /Apply requested changes/ })).toBeVisible();
  });
});
