import { handle, readBody } from '@/core/http';
import { service } from '@/core/service';
import { consultationInput } from '@/core/validation';
export const runtime = 'nodejs';
export async function POST(request: Request) { return handle(request, async () => service().start(consultationInput.parse(await readBody(request)))); }
