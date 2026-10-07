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
const ORPHAN_SESSION = JSON.stringify({
  title: 'Orphan session for deletion',
  project: 'Context Master deletion test',
  source: 'codex',
  externalId: 'orphan-session-for-deletion',
  messages: [
    { role: 'user', content: 'How should this unlinked session be removed?' },
    { role: 'assistant', content: 'The imported copy can be removed after checking that no specialist references it.' },
  ],
}, null, 2);
const FIXTURE_TIMES = {
  createdAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:00:01.000Z',
};

function consultationFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fixture-consultation',
    specialistId: 'fixture-specialist',
    specialistName: 'Synthetic desktop specialist',
    question: 'What decisions were made?',
    mode: 'answer',
    cli: 'codex',
    status: 'completed',
    answer: 'The harness keeps imported sessions read-only. [1]',
    evidence: [],
    context: 'Synthetic context packet',
    error: null,
    ...FIXTURE_TIMES,
    durationMs: 1000,
    briefRevision: 1,
    ...overrides,
  };
}

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
  await sessionDialog.getByRole('button', { name: 'Create specialist', exact: true }).click();
  const sourceEditor = page.getByRole('dialog', { name: 'Create a specialist' });
  await expect(sourceEditor).toBeVisible();
  await sourceEditor.getByRole('button', { name: 'Cancel' }).click();
  await expect(sourceEditor).toBeHidden();

  await page.getByRole('button', { name: 'Read saved context' }).click();
  await page.getByRole('button', { name: 'Edit context' }).click();
  const editDialog = page.getByRole('dialog', { name: 'Edit specialist' });
  await expect(editDialog).toBeVisible();
  const originalBrief = await editDialog.locator('textarea.brief-editor').inputValue();
  const editedBrief = `${originalBrief}\nRevision one adds a verification reminder.`;
  await editDialog.locator('textarea.brief-editor').fill(editedBrief);
  await editDialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Synthetic desktop specialist saved.')).toBeVisible();

  await page.getByRole('button', { name: 'Edit specialist', exact: true }).click();
  const versionsDialog = page.getByRole('dialog', { name: 'Edit specialist' });
  await versionsDialog.getByRole('button', { name: 'View saved versions' }).click();
  await expect(versionsDialog.getByText('Revision 1')).toBeVisible();
  await expect(versionsDialog.getByText('Revision 2')).toBeVisible();
  const firstVersion = versionsDialog.locator('.version-list > div').filter({ hasText: 'Revision 1' });
  await firstVersion.getByRole('button', { name: 'Use this version' }).click();
  await versionsDialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Synthetic desktop specialist saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Edit specialist', exact: true }).click();
  const restoredEditor = page.getByRole('dialog', { name: 'Edit specialist' });
  await expect(restoredEditor.locator('textarea.brief-editor')).toHaveValue(originalBrief);
  await restoredEditor.getByRole('button', { name: 'Cancel' }).click();

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

  await page.locator('button.compact-search').click();
  const compactSearch = page.getByRole('dialog', { name: 'Find a specialist' });
  await expect(compactSearch).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(compactSearch).toBeHidden();

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

test('covers keyboard search, list filters, source browsing, and session selection', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Synthetic desktop specialist', level: 2 })).toBeVisible();

  const filter = page.getByPlaceholder('Filter specialists');
  await filter.fill('desktop');
  await expect(page.locator('.specialist-row').filter({ hasText: 'Synthetic desktop specialist' })).toBeVisible();
  await page.getByRole('button', { name: 'Archived' }).click();
  await expect(page.getByText('No archived specialists match.')).toBeVisible();
  await page.getByRole('button', { name: 'Available' }).click();

  await page.keyboard.press('Control+k');
  const search = page.getByRole('dialog', { name: 'Find a specialist' });
  await expect(search).toBeVisible();
  await search.getByPlaceholder('What do you need help with?').fill('synthetic desktop');
  const result = search.getByRole('button', { name: /Synthetic desktop specialist/ });
  await expect(result).toBeVisible();
  await result.click();
  await expect(search).toBeHidden();

  await page.getByRole('button', { name: 'Read saved context' }).click();
  const network = page.locator('.network-map');
  await expect(network).toBeVisible();
  const source = network.locator('.network-sources button').first();
  await expect(source).toBeVisible();
  await source.click();
  const sourceDialog = page.getByRole('dialog', { name: 'Synthetic desktop session' });
  await expect(sourceDialog).toBeVisible();
  await expect(sourceDialog.getByText(/The harness should cancel/)).toBeVisible();
  await sourceDialog.getByRole('button', { name: 'Close Synthetic desktop session' }).click();

  await page.getByRole('button', { name: /Browse sources/ }).click();
  const linkedSource = page.locator('.linked-source').first();
  await expect(linkedSource).toBeVisible();
  await linkedSource.click();
  await expect(page.getByRole('dialog', { name: 'Synthetic desktop session' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Synthetic desktop session' }).getByRole('button', { name: 'Close Synthetic desktop session' }).click();

  await page.getByRole('button', { name: 'Choose sessions', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sessions', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  const sessionCheckbox = page.getByRole('checkbox', { name: 'Select Synthetic desktop session' });
  await sessionCheckbox.check();
  await page.getByRole('button', { name: 'Create from 1 session' }).click();
  const editor = page.getByRole('dialog', { name: 'Create a specialist' });
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toBeHidden();
});

test('covers discovery filters, discovery import, and the native picker bridge', async ({ page }) => {
  const discovered = [
    { id: 'discovered-codex', source: 'codex', title: 'Codex architecture notes', project: 'context-master', updatedAt: '2026-01-02T00:00:00.000Z', bytes: 512 },
    { id: 'discovered-claude', source: 'claude', title: 'Claude migration notes', project: 'context-master', updatedAt: '2026-01-03T00:00:00.000Z', bytes: 768 },
  ];
  let lastQuery = '';
  let lastSource = '';
  await page.unroute('**/api/discovery**');
  await page.route('**/api/discovery**', async route => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        body: JSON.stringify({ results: [{ name: 'Claude migration notes', sessions: [{ id: 'fixture-discovered-session' }], duplicates: 0, redactions: 0, error: null }] }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }
    const url = new URL(route.request().url());
    lastQuery = url.searchParams.get('q') ?? '';
    lastSource = url.searchParams.get('source') ?? '';
    await route.fulfill({ body: JSON.stringify({ sessions: discovered, sources: [{ source: 'codex', path: '/fixture/codex', available: true, detail: 'Fixture source.' }, { source: 'claude', path: '/fixture/claude', available: true, detail: 'Fixture source.' }], truncated: false }), contentType: 'application/json', status: 200 });
  });

  await page.goto('/');
  const { dialog } = await openImportDialog(page);
  await expect(dialog.getByText('Codex architecture notes')).toBeVisible();
  await expect(dialog.getByText('Claude migration notes')).toBeVisible();
  await dialog.getByLabel('Filter by agent').selectOption('claude');
  await expect.poll(() => lastSource).toBe('claude');
  await expect(dialog.getByText('Claude migration notes')).toBeVisible();
  await expect(dialog.getByText('Codex architecture notes')).toBeHidden();
  await dialog.getByPlaceholder('Filter by session or project').fill('migration');
  await expect.poll(() => lastQuery).toBe('migration');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Import selected sessions' }).click();
  const discoveryResults = page.getByRole('dialog', { name: 'Import results' });
  await expect(discoveryResults).toBeVisible();
  await expect(discoveryResults.getByText(/1 added/)).toBeVisible();
  await discoveryResults.getByRole('button', { name: 'Close', exact: true }).click();

  await page.evaluate(() => {
    Object.defineProperty(window, 'contextMaster', { configurable: true, value: { pickFiles: async () => [{ name: 'native-bridge.txt', text: 'native picker fixture' }] } });
  });
  await page.route('**/api/import', async route => {
    await route.fulfill({ body: JSON.stringify({ results: [{ name: 'native-bridge.txt', sessions: [{ id: 'fixture-native-session' }], duplicates: 0, redactions: 0, error: null }] }), contentType: 'application/json', status: 200 });
  });
  const secondImport = await openImportDialog(page);
  await secondImport.dialog.getByRole('button', { name: 'Choose transcript files' }).click();
  await secondImport.dialog.getByRole('button', { name: 'Choose files' }).click();
  await expect(secondImport.dialog.getByText('native-bridge.txt')).toBeVisible();
  await secondImport.dialog.getByRole('button', { name: 'Import selected sessions' }).click();
  const nativeResults = page.getByRole('dialog', { name: 'Import results' });
  await expect(nativeResults).toBeVisible();
  await expect(nativeResults.getByText('native-bridge.txt')).toBeVisible();
  await nativeResults.getByRole('button', { name: 'Close', exact: true }).click();
  await page.unroute('**/api/import');
});

test('copies answer and context output and resets copied connection state on refresh', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:3231' });
  const libraryResponse = await page.request.get('/api/library');
  const library = await libraryResponse.json() as { specialists: { id: string; name: string }[] };
  const specialist = library.specialists.find(item => item.name === 'Synthetic desktop specialist');
  expect(specialist).toBeDefined();
  const specialistId = specialist?.id ?? '';
  let consultationCount = 0;
  await page.route('**/api/settings', async route => {
    await route.fulfill({ body: JSON.stringify({ clis: [{ id: 'codex', name: 'Codex', installed: true, ready: true, path: '/fixture/codex', version: 'fixture' }], dataDirectory: '/fixture/library', mcp: { command: 'node', args: ['mcp'], env: {} } }), contentType: 'application/json', status: 200 });
  });
  await page.route('**/api/consultations', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON() as { mode?: string; question?: string };
    consultationCount += 1;
    await route.fulfill({ body: JSON.stringify(consultationFixture({ id: `fixture-copy-${consultationCount}`, specialistId, specialistName: specialist?.name, mode: body.mode ?? 'answer', question: body.question ?? 'Fixture question', answer: body.mode === 'context' ? 'Context handoff fixture' : 'Answer fixture' })), contentType: 'application/json', status: 200 });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Local agents', level: 2 })).toBeVisible();
  const guide = page.locator('details.connection-guide');
  await guide.locator('summary').click();
  await expect(guide.getByRole('link', { name: /Read local server setup/ })).toHaveAttribute('href', 'https://modelcontextprotocol.io/docs/develop/connect-local-servers');
  await page.getByRole('button', { name: 'Copy configuration' }).click();
  await expect(page.getByRole('button', { name: 'Copied configuration' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('context-master');
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByRole('button', { name: 'Copy configuration' })).toBeVisible();

  await page.getByRole('button', { name: 'Specialists', exact: true }).click();
  await page.getByRole('group', { name: 'Specialist views' }).getByRole('button', { name: 'Ask specialist', exact: true }).click();
  const question = page.getByLabel('Your question');
  await question.fill('What decisions were made in the fixture?');
  const composer = page.locator('form.composer');
  await composer.getByRole('button', { name: 'Ask specialist', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copy answer' })).toBeVisible();
  await page.getByRole('button', { name: 'Copy answer' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Answer fixture');

  await page.getByLabel('Consultation mode').selectOption('context');
  await question.fill('Return the fixture context packet.');
  await composer.getByRole('button', { name: 'Get context', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copy context handoff' })).toBeVisible();
  await page.getByRole('button', { name: 'Copy context handoff' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Context handoff fixture');
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const activity = page.locator('.activity-row').first();
  await expect(activity).toBeVisible();
  await activity.click();
  await expect(page.getByText('Return the fixture context packet.')).toBeVisible();
  const runDetails = page.locator('details.run-details');
  await runDetails.locator(':scope > summary').click();
  await expect(runDetails.getByText('Context handoff, no agent call')).toBeVisible();
  await runDetails.locator('details > summary').click();
  await expect(runDetails.locator('pre.context-preview')).toContainText('Synthetic context packet');
  await page.unroute('**/api/settings');
  await page.unroute('**/api/consultations');
});

test('focuses suggested questions and handles stop and provider failure fixtures', async ({ page }) => {
  const libraryResponse = await page.request.get('/api/library');
  const library = await libraryResponse.json() as { sessions: { id: string }[] };
  expect(library.sessions.length).toBeGreaterThan(0);
  const createResponse = await page.request.post('/api/specialists', { data: { name: 'Fixture consultation specialist', description: 'Deterministic consultation controls.', brief: 'A deterministic fixture specialist for testing consultation controls.', tags: ['fixture'], cli: 'codex', sessionIds: [library.sessions[0].id] } });
  expect(createResponse.ok()).toBeTruthy();
  const created = await createResponse.json() as { id: string };
  let postCount = 0;
  await page.route('**/api/consultations', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    postCount += 1;
    const body = route.request().postDataJSON() as { question?: string };
    await route.fulfill({ body: JSON.stringify(consultationFixture({ id: postCount === 1 ? 'fixture-running' : 'fixture-failed', specialistId: created.id, specialistName: 'Fixture consultation specialist', status: postCount === 1 ? 'queued' : 'failed', question: body.question ?? 'Fixture question', answer: '', error: postCount === 1 ? null : 'Fixture provider failed without invoking a paid API.' })), contentType: 'application/json', status: 200 });
  });
  await page.route('**/api/consultations/**', async route => {
    if (route.request().method() === 'DELETE') {
      await route.fulfill({ body: JSON.stringify(consultationFixture({ id: 'fixture-running', specialistId: created.id, specialistName: 'Fixture consultation specialist', status: 'cancelled', answer: '', error: null })), contentType: 'application/json', status: 200 });
      return;
    }
    if (route.request().method() === 'GET') {
      await route.fulfill({ body: JSON.stringify({ consultation: consultationFixture({ id: 'fixture-running', specialistId: created.id, specialistName: 'Fixture consultation specialist', status: 'queued', answer: '', error: null }), events: [] }), contentType: 'application/json', status: 200 });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await page.getByPlaceholder('Filter specialists').fill('Fixture consultation');
  await page.getByRole('button', { name: /Fixture consultation specialist/ }).click();
  await page.getByRole('group', { name: 'Specialist views' }).getByRole('button', { name: 'Ask specialist', exact: true }).click();
  const question = page.getByLabel('Your question');
  const suggested = page.getByRole('button', { name: /Ask about decisions and open questions/ });
  await suggested.click();
  await expect(question).toHaveValue('What decisions were made, and what still needs verification?');
  await expect(question).toBeFocused();
  const composer = page.locator('form.composer');
  await composer.getByRole('button', { name: 'Ask specialist', exact: true }).click();
  await expect(composer.getByRole('button', { name: 'Stop run', exact: true })).toBeVisible();
  await composer.getByRole('button', { name: 'Stop run', exact: true }).click();
  await expect(page.getByText('This consultation was stopped.')).toBeVisible();

  await question.fill('Trigger the deterministic provider failure.');
  await composer.getByRole('button', { name: 'Ask specialist', exact: true }).click();
  await expect(page.locator('p.error-notice')).toContainText('Fixture provider failed without invoking a paid API.');
  await page.unroute('**/api/consultations');
  await page.unroute('**/api/consultations/**');
});

test('supports protected deletion, selection-based drafting, and successful orphan deletion', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('Filter specialists').fill('Synthetic desktop');
  await page.locator('.specialist-row').filter({ hasText: 'Synthetic desktop specialist' }).click();
  await page.getByRole('button', { name: 'Read saved context' }).click();
  await page.locator('.network-sources button').first().click();
  const protectedDialog = page.getByRole('dialog', { name: 'Synthetic desktop session' });
  await protectedDialog.getByRole('button', { name: 'Delete imported copy' }).click();
  await protectedDialog.getByRole('button', { name: 'Keep session' }).click();
  await expect(protectedDialog.getByText('Delete this imported copy?')).toBeHidden();
  await protectedDialog.getByRole('button', { name: 'Delete imported copy' }).click();
  await protectedDialog.getByRole('button', { name: 'Delete imported session' }).click();
  await expect(protectedDialog.getByRole('alert')).toContainText('This session supports a specialist');
  await protectedDialog.getByRole('button', { name: 'Close Synthetic desktop session' }).click();

  const importResponse = await page.request.post('/api/import', { data: { files: [{ name: 'orphan-session-for-deletion.json', text: ORPHAN_SESSION }] } });
  expect(importResponse.ok()).toBeTruthy();
  await page.reload();
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  const orphanCheckbox = page.getByRole('checkbox', { name: 'Select Orphan session for deletion' });
  await orphanCheckbox.check();
  await page.getByRole('button', { name: 'Create from 1 session' }).click();
  const editor = page.getByRole('dialog', { name: 'Create a specialist' });
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toBeHidden();

  await page.getByRole('button', { name: 'Orphan session for deletion' }).click();
  const orphanDialog = page.getByRole('dialog', { name: 'Orphan session for deletion' });
  await orphanDialog.getByRole('button', { name: 'Delete imported copy' }).click();
  await orphanDialog.getByRole('button', { name: 'Delete imported session' }).click();
  await expect(orphanDialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Create from selected sessions', exact: true })).toBeDisabled();
  const remaining = await (await page.request.get('/api/library')).json() as { sessions: { title: string }[] };
  expect(remaining.sessions.some(session => session.title === 'Orphan session for deletion')).toBe(false);
});
