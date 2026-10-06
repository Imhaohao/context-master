import { handle } from '@/core/http';
import { service } from '@/core/service';
export const runtime = 'nodejs';
export async function POST(request: Request) { return handle(request, async () => { await service().shutdown(); return { stopped: true }; }); }
