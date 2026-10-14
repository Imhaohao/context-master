import { handle } from '@/core/http';
import { service } from '@/core/service';
import { loadExamples } from '@/core/demo';
import { preferredCli } from '@/core/harness';
export const runtime = 'nodejs';
export async function POST(request: Request) { return handle(request, async () => loadExamples(service().store, await preferredCli())); }
