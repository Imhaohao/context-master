import { execFile } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function main() {
  const bundle = resolve(process.argv[2] ?? `release/mac-${process.arch}/Context Master.app`);
  const executable = join(bundle, 'Contents/MacOS/Context Master');
  const resources = join(bundle, 'Contents/Resources');
  await Promise.all([access(executable), access(join(resources, 'web/node_modules/next/package.json'))]);
  const directory = await mkdtemp(join(tmpdir(), 'context-master-desktop-smoke-'));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), NODE_ENV: 'production' as const, ELECTRON_RUN_AS_NODE: '1', CONTEXT_MASTER_DATA_DIR: directory };
  const client = new Client({ name: 'desktop-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: executable, args: [join(resources, 'agent/mcp.cjs')], env, stderr: 'pipe' });
  try {
    const output = await promisify(execFile)(executable, [join(resources, 'agent/cli.cjs'), 'library'], { env, timeout: 10000, maxBuffer: 1024 * 1024 });
    const library = JSON.parse(output.stdout) as { sessions: unknown[]; specialists: unknown[] };
    if (library.sessions.length || library.specialists.length) throw new Error('The smoke test library was not isolated.');
    await client.connect(transport);
    const tools = await client.listTools();
    if (tools.tools.length !== 4) throw new Error('The packaged MCP tool list is incomplete.');
    process.stdout.write('Packaged Electron runtime, isolated SQLite library, standalone dependencies, CLI, and stdio MCP server passed.\n');
  } finally { await client.close(); await transport.close(); await rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Desktop smoke test failed.'}\n`); process.exitCode = 1; });
