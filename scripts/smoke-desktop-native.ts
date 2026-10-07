import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';

async function main() {
  const bundle = resolve(process.argv[2] ?? `release/mac-${process.arch}/Context Master.app`);
  const webRoot = join(bundle, 'Contents/Resources/web');
  const originalResources = await resourceDigest(webRoot);
  const directory = await mkdtemp(join(tmpdir(), 'context-master-native-smoke-'));
  const environment: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), CONTEXT_MASTER_DATA_DIR: directory };
  delete environment.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ executablePath: join(bundle, 'Contents/MacOS/Context Master'), env: environment });
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Ask your past work' })).toBeVisible();
    const url = new URL('/api/library', page.url());
    const response = await fetch(url);
    if (response.status !== 401) throw new Error('The packaged backend allowed an unauthenticated library request.');
    await page.getByRole('button', { name: 'Try examples' }).click();
    await page.getByRole('button', { name: 'Dismiss notification' }).click();
    const connectionRail = page.getByRole('button', { name: 'Connections', exact: true });
    await page.getByRole('button', { name: 'Activity', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(connectionRail).toBeFocused();
    await expect(connectionRail.locator('.control-tooltip')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(connectionRail.locator('.control-tooltip')).toBeHidden();
    await page.getByRole('tab', { name: 'Brief', exact: true }).click();
    await expect(page.locator('.network-map')).toBeVisible();
    const briefDetails = page.locator('details.brief-info');
    await briefDetails.locator('summary').click();
    await expect(briefDetails).toContainText('Revision');
    const families = await page.locator('.app-shell').evaluate(element => [...new Set(Array.from(element.querySelectorAll('*')).filter(child => child instanceof HTMLElement).map(child => getComputedStyle(child).fontFamily))]);
    if (families.some(family => !family.includes('IBM Plex Sans'))) throw new Error('The packaged interface uses an unexpected font family.');
    const artifacts = resolve('test-results/native');
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, 'context-master.png') });
    await page.getByRole('tab', { name: 'Ask', exact: true }).click();
    await page.getByLabel('Consultation mode').selectOption('context');
    await page.getByLabel('Your question').fill('What should another agent verify before acting?');
    await page.getByRole('button', { name: 'Handoff', exact: true }).click();
    await expect(page.getByText('Context ready', { exact: true })).toBeVisible();
    await app.close();
    const running = await fetch(url).then(() => true, () => false);
    if (running) throw new Error('The packaged backend remained available after quitting.');
    await verifyCrash(bundle, environment);
    if (await resourceDigest(webRoot) !== originalResources) throw new Error('The backend changed its packaged runtime resources.');
    process.stdout.write('Native packaged renderer, token protection, context handoff, screenshot, shutdown, forced-crash cleanup, and immutable runtime resources passed.\n');
  } finally { await app?.close().catch(() => undefined); await rm(directory, { recursive: true, force: true }); }
}
async function resourceDigest(directory: string) {
  const files = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort();
  const digest = createHash('sha256');
  for (const file of files) { digest.update(file); digest.update(await readFile(file)); }
  return digest.digest('hex');
}
async function verifyCrash(bundle: string, environment: Record<string, string>) {
  const app = await electron.launch({ executablePath: join(bundle, 'Contents/MacOS/Context Master'), env: environment });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Import sessions', exact: true })).toBeVisible();
    const url = new URL('/api/library', page.url());
    app.process().kill('SIGKILL');
    await expect.poll(() => fetch(url).then(() => true, () => false)).toBe(false);
  } finally { await app.close().catch(() => undefined); }
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Native desktop smoke test failed.'}\n`); process.exitCode = 1; });
