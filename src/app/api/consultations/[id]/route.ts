import { handle } from '@/core/http';
import { service } from '@/core/service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Params) {
  return handle(request, async () => {
    const id = (await context.params).id; const store = service().store;
    return { consultation: store.consultation(id), events: store.events(id) };
  });
}
export async function DELETE(request: Request, context: Params) { return handle(request, async () => service().cancel((await context.params).id)); }
