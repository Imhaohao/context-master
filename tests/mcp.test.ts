import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { LibraryStore } from '../src/core/store';

it('shares a persisted library through an actual stdio MCP client', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-master-mcp-test-'));
  const previous = process.env.CONTEXT_MASTER_DATA_DIR;
  process.env.CONTEXT_MASTER_DATA_DIR = directory;
  const store = new LibraryStore();
  const session = store.import(JSON.stringify({ title: 'Synthetic migration', messages: [
    { role: 'user', content: 'How should migrations preserve SQLite sessions?' },
    { role: 'assistant', content: 'Wrap schema migrations in BEGIN IMMEDIATE and reject newer schema versions.' }
  ] }), 'synthetic.json').sessions[0];
  const specialist = store.createSpecialist({ name: 'Migration specialist', description: 'SQLite migration decisions',
    brief: 'Schema migrations use transactions.', tags: ['sqlite'], cli: 'codex', sessionIds: [session.id] });
  store.close();
  if (previous === undefined) delete process.env.CONTEXT_MASTER_DATA_DIR;
  else process.env.CONTEXT_MASTER_DATA_DIR = previous;
  const client = new Client({ name: 'context-master-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/mcp.ts')],
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), CONTEXT_MASTER_DATA_DIR: directory }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['search_specialists', 'get_specialist_context', 'ask_specialist', 'get_consultation']));
    const search = await client.callTool({ name: 'search_specialists', arguments: { question: 'SQLite migrations' } });
    expect(JSON.stringify(search.content)).toContain(specialist.id);
    const context = await client.callTool({ name: 'get_specialist_context', arguments: { specialistId: specialist.id, question: 'How do migrations work?' } });
    expect(JSON.stringify(context.content)).toContain('BEGIN IMMEDIATE');
    expect((await client.listResources()).resources[0].uri).toBe(`specialist://${specialist.id}`);
    expect((await client.readResource({ uri: `specialist://${specialist.id}` })).contents[0]).toMatchObject({ text: expect.stringContaining('Schema migrations use transactions.') });
    const invalid = await client.callTool({ name: 'get_specialist_context', arguments: { specialistId: 'invalid', question: 'why' } });
    expect(invalid.isError).toBe(true);
  } finally {
    await client.close();
    await transport.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
