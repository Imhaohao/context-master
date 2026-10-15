// Captures artifact/context-master.webp from the packaged app: loads the example
// library, has a separate Claude Code process ask a specialist over MCP, then
// screenshots the answer. Needs a logged-in Claude Code CLI and uses its subscription.
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron, expect } from '@playwright/test';

const run = promisify(execFile);
const question = 'A student was charged once but got two booking confirmation emails. Ask the right context-master specialist why this happens and what we decided to do. Reply with its answer.';

function cleanEnvironment(dataDirectory: string): Record<string, string> {
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete environment.ELECTRON_RUN_AS_NODE;
  return { ...environment, CONTEXT_MASTER_DATA_DIR: dataDirectory };
}

async function askOverMcp(bundle: string, dataDirectory: string, workspace: string) {
  const server = { command: join(bundle, 'Contents/MacOS/Context Master'), args: [join(bundle, 'Contents/Resources/agent/mcp.cjs')], env: { ELECTRON_RUN_AS_NODE: '1', CONTEXT_MASTER_DATA_DIR: dataDirectory } };
  const configPath = join(workspace, 'mcp.json');
  await writeFile(configPath, JSON.stringify({ mcpServers: { 'context-master': server } }));
  const tools = 'mcp__context-master__search_specialists,mcp__context-master__ask_specialist';
  const { stdout } = await run('claude', ['-p', question, '--mcp-config', configPath, '--strict-mcp-config', '--allowedTools', tools, '--output-format', 'json'], { cwd: workspace, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout) as { result?: string; is_error?: boolean };
}

async function main() {
  const bundle = resolve(process.argv[2] ?? `release/mac-${process.arch}/Context Master.app`);
  const output = resolve('artifact/context-master.png');
  const workspace = await mkdtemp(join(tmpdir(), 'context-master-artifact-'));
  const dataDirectory = join(workspace, 'library');
  const app = await electron.launch({ executablePath: join(bundle, 'Contents/MacOS/Context Master'), env: cleanEnvironment(dataDirectory) });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1200, 750));
    await page.getByRole('button', { name: 'Try the example library' }).click();
    await expect(page.locator('.specialist-list').getByText('Tidepool payments')).toBeVisible();
    const reply = await askOverMcp(bundle, dataDirectory, workspace);
    if (reply.is_error || !reply.result) throw new Error('The outside agent did not finish its MCP consultation.');
    process.stdout.write(`Claude Code replied:\n${reply.result}\n`);
    await page.reload();
    await page.locator('.specialist-list').getByText('Tidepool payments').click();
    await expect(page.getByText('Asked by Claude Code')).toBeVisible({ timeout: 15_000 });
    await mkdir(resolve('artifact'), { recursive: true });
    await page.screenshot({ path: output });
    await run('cwebp', ['-quiet', '-q', '90', output, '-o', output.replace(/\.png$/u, '.webp')]);
    await rm(output);
    process.stdout.write('Saved artifact/context-master.webp\n');
  } finally {
    await app.close().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Artifact capture failed.'}\n`); process.exitCode = 1; });
