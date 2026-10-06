import { handle } from '@/core/http';
import { service } from '@/core/service';
export const runtime = 'nodejs';
type Params = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Params) { return handle(request, async () => service().store.session((await context.params).id)); }
export async function DELETE(request: Request, context: Params) { return handle(request, async () => { service().store.deleteSession((await context.params).id); return { deleted: true }; }); }
