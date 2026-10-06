import { handle } from '@/core/http';
import { service } from '@/core/service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { return handle(request, () => { const app = service(); app.store.recoverAbandonedRuns(); return app.store.library(); }); }
