import { z } from 'zod';
import { handle, readBody } from '@/core/http';
import { service } from '@/core/service';
import { specialistUpdate } from '@/core/validation';
export const runtime = 'nodejs';
type Params = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Params) {
  return handle(request, async () => { const id = (await context.params).id; const store = service().store; return { specialist: store.specialist(id), versions: store.versions(id) }; });
}
export async function PATCH(request: Request, context: Params) {
  return handle(request, async () => {
    const id = (await context.params).id; const body = await readBody(request);
    const archive = z.object({ archived: z.boolean() }).strict().safeParse(body);
    return archive.success ? service().store.archiveSpecialist(id, archive.data.archived) : service().store.updateSpecialist(id, specialistUpdate.parse(body));
  });
}
