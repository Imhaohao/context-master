import { z } from 'zod';
import { handle, readBody } from '@/core/http';
import { service } from '@/core/service';
import { discoverSessions, loadDiscoveredSession } from '@/core/discovery';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return handle(request, () => {
    const parameters = new URL(request.url).searchParams;
    const filters = z.object({ query: z.string().max(1000), source: z.enum(['codex', 'claude', 'opencode', 'cursor']).optional() })
      .parse({ query: parameters.get('q') ?? '', source: parameters.get('source') ?? undefined });
    return discoverSessions(filters);
  });
}
export async function POST(request: Request) {
  return handle(request, async () => {
    const { ids } = z.object({ ids: z.array(z.string().min(1).max(200)).min(1).max(20) }).parse(await readBody(request));
    const results = [];
    for (const id of ids) {
      try { const file = await loadDiscoveredSession(id); results.push({ name: file.name, ...service().store.import(file.text, file.name), error: null }); }
      catch (error) { results.push({ name: id, sessions: [], duplicates: 0, redactions: 0, error: error instanceof Error ? error.message : 'Could not import this session.' }); }
    }
    return { results };
  });
}
