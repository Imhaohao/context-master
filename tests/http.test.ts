import { afterEach, describe, expect, it } from 'vitest';
import { guardRequest, handle, readBody } from '../src/core/http';
const originalToken = process.env.CONTEXT_MASTER_TOKEN;
afterEach(() => { if (originalToken === undefined) delete process.env.CONTEXT_MASTER_TOKEN; else process.env.CONTEXT_MASTER_TOKEN = originalToken; });
describe('local HTTP trust boundary', () => {
  it('uses the validated Host authority when Next internally uses another loopback host', () => {
    delete process.env.CONTEXT_MASTER_TOKEN;
    expect(() => guardRequest(new Request('http://localhost:3211/api/demo', { headers: { host: '127.0.0.1:3211', origin: 'http://127.0.0.1:3211' } }))).not.toThrow();
  });
  it('rejects foreign origins, DNS rebinding hosts, and cross-site fetches', () => {
    const cases: Record<string, string>[] = [{ host: 'evil.example' }, { host: '127.0.0.1:3211', origin: 'https://evil.example' }, { host: '127.0.0.1:3211', 'sec-fetch-site': 'cross-site' }];
    for (const headers of cases) {
      expect(() => guardRequest(new Request('http://127.0.0.1:3211/api/library', { headers }))).toThrow();
    }
  });
  it('requires the app token and accepts only matching bearer or HttpOnly cookie values', () => {
    process.env.CONTEXT_MASTER_TOKEN = 'local-secret-value';
    expect(() => guardRequest(new Request('http://127.0.0.1/api/library'))).toThrow('not authorized');
    expect(() => guardRequest(new Request('http://127.0.0.1/api/library', { headers: { authorization: 'Bearer local-secret-value' } }))).not.toThrow();
    expect(() => guardRequest(new Request('http://127.0.0.1/api/library', { headers: { cookie: 'other=x; cm_session=local-secret-value' } }))).not.toThrow();
  });
  it('limits streamed request bodies even without a Content-Length header', async () => {
    const request = new Request('http://localhost/api/import', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(100) }) });
    await expect(readBody(request, 20)).rejects.toThrow('too large');
  });
  it('returns actionable JSON errors without leaking internal exception details', async () => {
    delete process.env.CONTEXT_MASTER_TOKEN;
    const response = await handle(new Request('http://localhost/api/library'), () => { throw new Error('private server path'); });
    expect(response.status).toBe(500); expect(await response.text()).not.toContain('private server path');
  });
});
