import { z } from 'zod';
import { handle, readBody } from '@/core/http';
import { service } from '@/core/service';
import { draftBrief } from '@/core/context';
import { specialistInput } from '@/core/validation';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  return handle(request, async () => {
    const body = await readBody(request); const store = service().store;
    const draft = z.object({ action: z.literal('draft'), sessionIds: z.array(z.string().uuid()).min(1).max(30) }).safeParse(body);
    if (draft.success) return draftBrief(draft.data.sessionIds.map(id => store.session(id)));
    return store.createSpecialist(specialistInput.parse(body));
  });
}
