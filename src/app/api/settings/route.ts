import { handle } from '@/core/http';
import { getCliStatuses } from '@/core/harness';
import { dataDirectory } from '@/core/database';
import { resolve } from 'node:path';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return handle(request, async () => ({
    clis: await getCliStatuses(), dataDirectory: dataDirectory(),
    mcp: { command: process.env.CONTEXT_MASTER_NODE ?? process.execPath,
      args: process.env.CONTEXT_MASTER_MCP_ENTRY ? [process.env.CONTEXT_MASTER_MCP_ENTRY] : [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/mcp.ts')],
      env: { CONTEXT_MASTER_DATA_DIR: dataDirectory(), ...(process.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } }
  }));
}
