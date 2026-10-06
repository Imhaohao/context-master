import { handle } from '@/core/http';
import { service } from '@/core/service';
import { loadExamples } from '@/core/demo';
export const runtime = 'nodejs';
export async function POST(request: Request) { return handle(request, () => loadExamples(service().store)); }
