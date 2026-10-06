import path from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, request as playwrightRequest, test, type Locator, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const TEST_ARTIFACT_DIRECTORY = path.join(process.cwd(), 'test-results', 'e2e-library');
const SYNTHETIC_FILE_NAME = 'synthetic-desktop-session.json';
const SYNTHETIC_SESSION = JSON.stringify({
  title: 'Synthetic desktop session',
  project: 'Context Master test harness',
  source: 'codex',
  messages: [
    {
      role: 'user',
      content: 'How should the desktop harness handle cancellation, evidence links, and context-only handoffs?',
    },
    {
      role: 'assistant',
      content: 'The harness should cancel the whole specialist process group, keep the imported session unchanged, and link every answer claim to an exact source message. A context-only handoff should return a bounded brief and evidence bundle without calling a model.',
    },
    {
      role: 'user',
      content: 'What must the next agent verify before acting on the saved context?',
    },
    {
      role: 'assistant',
      content: 'Treat saved context as historical. Inspect the linked source transcript and verify current behavior before making an irreversible change.',
    },
  ],
}, null, 2);

test.beforeEach(async ({ page }) => {
  await page.route('**/api/discovery**', async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessions: [], sources: [], truncated: false }),
      contentType: 'application/json',
      status: 200,
    });
  });
});

async function openImportDialog(page: Page): Promise<{ dialog: Locator; trigger: Locator }> {
  const trigger = page.getByRole('button', { name: 'Import sessions' }).first();
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Import sessions' });
  await expect(dialog).toBeVisible();
  return { dialog, trigger };
}

async function selectSyntheticFile(page: Page, dialog: Locator) {
  await dialog.getByRole('button', { name: 'Choose transcript files' }).click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose files' }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    buffer: Buffer.from(SYNTHETIC_SESSION, 'utf8'),
    mimeType: 'application/json',
    name: SYNTHETIC_FILE_NAME,
  });
  await expect(dialog.getByText(SYNTHETIC_FILE_NAME)).toBeVisible();
}

async function importSyntheticFile(page: Page): Promise<Locator> {
  const { dialog } = await openImportDialog(page);
  await selectSyntheticFile(page, dialog);
  await dialog.getByRole('button', { name: 'Import selected sessions' }).click();
  const results = page.getByRole('dialog', { name: 'Import results' });
  await expect(results).toBeVisible();
  return results;
}

async function expectNoHorizontalOverflow(page: Page) {
  const diagnostics = await page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth;
    const offenders = Array.from(document.querySelectorAll<HTMLElement>('*')).map(element => {
      const rect = element.getBoundingClientRect();
      return { tag: element.tagName.toLowerCase(), className: element.className, right: Math.round(rect.right), width: Math.round(rect.width) };
    }).filter(element => element.right > clientWidth + 1).sort((left, right) => right.right - left.right).slice(0, 8);
    return { clientWidth, scrollWidth: document.documentElement.scrollWidth, offenders };
  });
  expect(diagnostics.scrollWidth, JSON.stringify(diagnostics.offenders)).toBeLessThanOrEqual(diagnostics.clientWidth + 1);
}

test('rejects foreign origins and malformed imports at the local API boundary', async ({ request }) => {
  const foreignOrigin = await request.get('/api/library', { headers: { Origin: 'https://example.invalid' } });
  expect(foreignOrigin.status()).toBe(403);
  await expect(foreignOrigin.json()).resolves.toMatchObject({ error: expect.stringContaining('another site') });

  const hostile = await playwrightRequest.newContext({
    baseURL: 'http://127.0.0.1:3231',
    extraHTTPHeaders: { Host: 'evil.example' },
  });
  try {
    const foreignHost = await hostile.get('/api/library');
    expect(foreignHost.status()).toBe(403);
    await expect(foreignHost.json()).resolves.toMatchObject({ error: expect.stringContaining('local connections') });
  } finally {
    await hostile.dispose();
  }

  const malformed = await request.post('/api/import', {
    data: { files: [{ name: 'malformed.json', text: '{"messages": []}' }] },
  });
  expect(malformed.ok()).toBeTruthy();
  await expect(malformed.json()).resolves.toMatchObject({
    results: [{ error: expect.stringContaining('No visible user or assistant messages') }],
  });
});

test('imports a synthetic session, creates and consults a specialist, edits versions, restores it, and detects duplicates', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Build your specialist library' })).toBeVisible();

  const { dialog: escapedDialog, trigger: importTrigger } = await openImportDialog(page);
  await page.keyboard.press('Escape');
  await expect(escapedDialog).toBeHidden();
  await expect(importTrigger).toBeFocused();

  const results = await importSyntheticFile(page);
  await expect(results.getByText(/1 added/)).toBeVisible();
  await results.getByRole('button', { name: 'Create a specialist' }).click();

  const editor = page.getByRole('dialog', { name: 'Create a specialist' });
  await expect(editor).toBeVisible();
  await editor.getByLabel('Name').fill('Synthetic desktop specialist');
  await editor.getByLabel('Specialist scope').fill('Answer questions about safe desktop harness behavior and evidence-linked context handoffs.');
  await editor.locator('textarea.brief-editor').fill('The synthetic harness keeps imported sessions read-only, returns bounded context, and links claims to source messages.');
  await editor.getByLabel('Tags').fill('desktop, evidence');
  await editor.getByRole('button', { name: 'Create specialist' }).click();
  await expect(editor).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Synthetic desktop specialist', level: 2 })).toBeVisible();

  await page.getByRole('button', { name: 'Read saved context' }).click();
  await expect(page.getByText(/characters saved/)).toBeVisible();
  await page.screenshot({ path: path.join(TEST_ARTIFACT_DIRECTORY, 'synthetic-demo-library.png'), fullPage: true });

  await page.getByRole('button', { name: 'Ask specialist' }).click();
  await page.getByLabel('Consultation mode').selectOption('context');
  await page.getByLabel('Your question').fill('What did the synthetic harness decide about cancellation, evidence, and context-only handoffs?');
  await page.getByRole('button', { name: 'Get context' }).click();
  await expect(page.getByText('Context ready')).toBeVisible();
  await expect(page.locator('.context-answer pre')).toContainText('Synthetic desktop specialist');
  await page.screenshot({ path: path.join(TEST_ARTIFACT_DIRECTORY, 'context-only-consultation.png'), fullPage: true });

  await page.locator('details.evidence-list > summary').click();
  const evidence = page.locator('.evidence-item').first();
  await expect(evidence).toBeVisible();
  await evidence.click();
  const sessionDialog = page.getByRole('dialog', { name: 'Synthetic desktop session' });
  await expect(sessionDialog).toBeVisible();
  await expect(sessionDialog.getByText(/The harness should cancel/)).toBeVisible();
  await sessionDialog.getByRole('button', { name: 'Close Synthetic desktop session' }).click();

  await page.getByRole('button', { name: 'Read saved context' }).click();
  await page.getByRole('button', { name: 'Edit context' }).click();
  const editDialog = page.getByRole('dialog', { name: 'Edit specialist' });
  await expect(editDialog).toBeVisible();
  const editedBrief = `${await editDialog.locator('textarea.brief-editor').inputValue()}\nRevision one adds a verification reminder.`;
  await editDialog.locator('textarea.brief-editor').fill(editedBrief);
  await editDialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Synthetic desktop specialist saved.')).toBeVisible();

  await page.getByRole('button', { name: 'Edit specialist', exact: true }).click();
  const versionsDialog = page.getByRole('dialog', { name: 'Edit specialist' });
  await versionsDialog.getByRole('button', { name: 'View saved versions' }).click();
  await expect(versionsDialog.getByText('Revision 1')).toBeVisible();
  await expect(versionsDialog.getByText('Revision 2')).toBeVisible();
  await versionsDialog.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByText('This specialist is archived.')).toBeVisible();
  await page.getByRole('button', { name: 'Restore specialist' }).click();
  await expect(page.getByText('This specialist is archived.')).toBeHidden();

  const duplicateResults = await importSyntheticFile(page);
  await expect(duplicateResults.getByText(/0 added, 1 already imported/)).toBeVisible();
  await duplicateResults.getByRole('button', { name: 'Close', exact: true }).click();
});

test('persists the selected theme and keeps motion reduced in loading states', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Synthetic desktop specialist', level: 2 })).toBeVisible();

  await page.getByRole('button', { name: 'Connections' }).click();
  const theme = page.getByLabel('Color theme');
  await expect(theme).toHaveValue('dark');
  await theme.selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('context-master-theme'))).toBe('light');

  await page.reload();
  await page.getByRole('button', { name: 'Connections' }).click();
  await expect(page.getByLabel('Color theme')).toHaveValue('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Specialists' }).click();
  await page.getByRole('button', { name: 'Read saved context' }).click();
  await expect(page.locator('.network-map')).toBeVisible();
  await expect.poll(() => page.locator('.network-wire-active').evaluate(element => getComputedStyle(element).animationName)).toBe('none');

  const { dialog } = await openImportDialog(page);
  await selectSyntheticFile(page, dialog);
  await page.route('**/api/import', async route => {
    await new Promise(resolve => setTimeout(resolve, 500));
    await route.continue();
  });
  try {
    const importButton = dialog.getByRole('button', { name: 'Import selected sessions' });
    await importButton.click();
    await expect(importButton.locator('.spin')).toBeVisible();
    await expect.poll(() => importButton.locator('.spin').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
    await expect(page.getByRole('dialog', { name: 'Import results' })).toBeVisible();
  } finally {
    await page.unroute('**/api/import');
  }
  await page.getByRole('dialog', { name: 'Import results' }).getByRole('button', { name: 'Close', exact: true }).click();
});

test('keeps the workspace usable at 320px and 200% text zoom', async ({ page }) => {
  await page.setViewportSize({ height: 720, width: 320 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Synthetic desktop specialist', level: 2 })).toBeVisible();
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await expectNoHorizontalOverflow(page);

  const { dialog } = await openImportDialog(page);
  await expect(dialog.getByRole('button', { name: 'Choose transcript files' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

for (const scenario of [
  { name: 'desktop dark', width: 1280, height: 820, theme: undefined },
  { name: 'desktop light', width: 1280, height: 820, theme: 'light' },
  { name: 'mobile dark', width: 390, height: 844, theme: undefined },
] as const) {
  test(`passes axe checks in ${scenario.name}`, async ({ page }) => {
    await page.setViewportSize({ height: scenario.height, width: scenario.width });
    await page.goto('/');
    if (scenario.theme) await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, scenario.theme);
    await expect(page.getByRole('heading', { name: 'Synthetic desktop specialist', level: 2 })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations).toEqual([]);
  });
}
