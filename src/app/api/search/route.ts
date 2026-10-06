import { z } from 'zod';
import { handle } from '@/core/http';
import { service } from '@/core/service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { return handle(request, () => service().search(z.string().max(4000).parse(new URL(request.url).searchParams.get('q') ?? ''))); }
