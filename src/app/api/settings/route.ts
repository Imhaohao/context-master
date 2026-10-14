import { handle } from '@/core/http';
import { getCliStatuses } from '@/core/harness';
import { dataDirectory, defaultDataDirectory } from '@/core/database';
import { agentConnections, type McpLaunch } from '@/core/connections';
import { resolve } from 'node:path';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
function mcpLaunch(): McpLaunch {
  const env: Record<string, string> = {};
  if (dataDirectory() !== defaultDataDirectory()) env.CONTEXT_MASTER_DATA_DIR = dataDirectory();
  if (process.env.ELECTRON_RUN_AS_NODE) env.ELECTRON_RUN_AS_NODE = '1';
  return { command: process.env.CONTEXT_MASTER_NODE ?? process.execPath,
    args: process.env.CONTEXT_MASTER_MCP_ENTRY ? [process.env.CONTEXT_MASTER_MCP_ENTRY] : [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/mcp.ts')], env };
}
export async function GET(request: Request) {
  return handle(request, async () => {
    const mcp = mcpLaunch();
    return { clis: await getCliStatuses(), dataDirectory: dataDirectory(), mcp, connections: agentConnections(mcp) };
  });
}
