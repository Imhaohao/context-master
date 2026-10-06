import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/core/database';
import { LibraryStore } from '../src/core/store';
import { SpecialistService } from '../src/core/service';
import type { SpecialistInput } from '../src/core/harness';
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/core/harness', () => ({ runSpecialist: run }));
const stores: LibraryStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); vi.useRealTimers(); run.mockReset(); });
function setup() {
  const store = new LibraryStore(openDatabase(':memory:')); stores.push(store);
  const session = store.import(JSON.stringify({ messages: [{ role: 'user', content: 'Synthetic cancellation decisions' }] }), 'session.json').sessions[0];
  const specialist = store.createSpecialist({ name: 'Synthetic', description: '', brief: 'Historical context', tags: [], cli: 'codex', sessionIds: [session.id] });
  return { store, specialist, service: new SpecialistService(store) };
}
it('redacts a question before persistence and context export', async () => {
  const { store, specialist, service } = setup();
  const result = service.start({ specialistId: specialist.id, question: 'What about api_key=superSecretValue123456789?', mode: 'context' });
  expect(JSON.stringify(store.consultation(result.id))).not.toContain('superSecretValue');
  expect(result.question).toContain('[credential redacted]');
  expect(run).not.toHaveBeenCalled();
  await service.shutdown();
});
it('waits for actual execution cleanup before shutdown completes', async () => {
  vi.useFakeTimers();
  run.mockImplementation((input: SpecialistInput) => new Promise((_, reject) => input.signal?.addEventListener('abort', () => {
    setTimeout(() => reject(new Error('Process terminated')), 4000);
  }, { once: true })));
  const { specialist, service } = setup();
  service.start({ specialistId: specialist.id, question: 'What happened?', mode: 'answer' });
  await vi.advanceTimersByTimeAsync(1);
  let settled = false;
  const shutdown = service.shutdown().then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(3001);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  await shutdown;
  expect(settled).toBe(true);
  expect(() => service.start({ specialistId: specialist.id, question: 'Again?' })).toThrow('shutting down');
});
it('aborts execution after another process recovers its stale run', async () => {
  vi.useFakeTimers();
  let aborted = false;
  run.mockImplementation((input: SpecialistInput) => new Promise((_, reject) => input.signal?.addEventListener('abort', () => {
    aborted = true; reject(new Error('Process terminated'));
  }, { once: true })));
  const { store, specialist, service } = setup();
  const result = service.start({ specialistId: specialist.id, question: 'What happened?', mode: 'answer' });
  await vi.advanceTimersByTimeAsync(1);
  store.db.prepare('UPDATE consultations SET heartbeat=? WHERE id=?').run(new Date(Date.now() - 60000).toISOString(), result.id);
  expect(store.recoverAbandonedRuns()).toBe(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(aborted).toBe(true);
  expect(store.consultation(result.id).status).toBe('failed');
  await service.shutdown();
});
