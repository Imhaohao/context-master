import { timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';
import { AppError } from './validation';

export function guardRequest(request: Request) {
  const url = new URL(request.url);
  const localUrl = new URL(`http://${request.headers.get('host') ?? url.host}`);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(localUrl.hostname) || localUrl.username || localUrl.password) throw new AppError('Context Master accepts local connections only.', 403);
  const origin = request.headers.get('origin');
  if (origin && origin !== localUrl.origin) throw new AppError('This request came from another site. Open Context Master directly.', 403);
  const site = request.headers.get('sec-fetch-site');
  if (site === 'cross-site') throw new AppError('Cross-site access is blocked.', 403);
  const token = process.env.CONTEXT_MASTER_TOKEN;
  if (!token) return;
  const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '');
  const cookie = request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith('cm_session='))?.slice(11);
  const candidate = bearer ?? cookie ?? '';
  if (!equalSecret(token, candidate)) throw new AppError('This local connection is not authorized. Reopen the Mac app.', 401);
}
function equalSecret(expected: string, actual: string): boolean {
  const a = Buffer.from(expected); const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function readBody(request: Request, maximum = 1024 * 1024): Promise<unknown> {
  const size = Number(request.headers.get('content-length') ?? 0);
  if (size > maximum) throw new AppError('The upload is too large. Import fewer files at once.', 413);
  if (!request.body) throw new AppError('No request data was provided. Try again.');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > maximum) { await reader.cancel(); throw new AppError('The upload is too large. Import fewer files at once.', 413); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('The request is not valid JSON. Check the input and try again.');
  } finally { reader.releaseLock(); }
}
export async function handle(request: Request, operation: () => unknown | Promise<unknown>): Promise<Response> {
  try { guardRequest(request); return Response.json(await operation(), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) {
    if (error instanceof ZodError) return Response.json({ error: error.issues.map(issue => `${issue.path.join('.') || 'Input'}: ${issue.message}`).join('; ') }, { status: 400 });
    if (error instanceof AppError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: 'Context Master could not complete this request. Try again or restart the app.' }, { status: 500 });
  }
}
