import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openDatabase } from '../src/core/database';
import { LibraryStore } from '../src/core/store';

const directories: string[] = [];
const stores: LibraryStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });
function sharedLibrary() {
  const directory = mkdtempSync(join(tmpdir(), 'context-master-lifecycle-')); directories.push(directory);
  const path = join(directory, 'library.db');
  const first = new LibraryStore(openDatabase(path)); const second = new LibraryStore(openDatabase(path)); stores.push(first, second);
  const session = first.import(JSON.stringify({ messages: [{ role: 'user', content: 'Synthetic shared library' }] }), 'session.json').sessions[0];
  const specialist = first.createSpecialist({ name: 'Synthetic', description: '', brief: 'Test lifecycle', tags: [], cli: 'codex', sessionIds: [session.id] });
  const create = (owner?: string) => first.createConsultation({ specialistId: specialist.id, question: 'What happened?', mode: 'answer', cli: 'codex', evidence: [], context: 'Test', owner });
  return { first, second, create };
}
it('enforces the same two-run limit across independent database connections', () => {
  const { first, second, create } = sharedLibrary(); const runs = [create(), create(), create()];
  expect(first.claimRun(runs[0].id, 'first')).toBe(true);
  expect(second.claimRun(runs[1].id, 'second')).toBe(true);
  expect(first.claimRun(runs[2].id, 'first')).toBe(false);
  second.transitionRun(runs[0].id, 'cancelled');
  expect(first.claimRun(runs[2].id, 'first')).toBe(true);
});
it('recovers stale runs while preserving another process’s live heartbeat', () => {
  const { first, second, create } = sharedLibrary(); const stale = create(); const live = create();
  first.claimRun(stale.id, 'gone'); second.claimRun(live.id, 'alive');
  first.db.prepare('UPDATE consultations SET heartbeat=? WHERE id=?').run(new Date(Date.now() - 60000).toISOString(), stale.id);
  expect(second.recoverAbandonedRuns()).toBe(1);
  expect(first.consultation(stale.id).status).toBe('failed');
  expect(first.consultation(live.id).status).toBe('running');
  first.transitionRun(stale.id, 'completed', { answer: 'Late response' });
  expect(second.consultation(stale.id).answer).toBe('');
});
it('keeps a queued run with its owning service', () => {
  const { first, second, create } = sharedLibrary(); const run = create('first');
  expect(second.claimRun(run.id, 'second')).toBe(false);
  expect(first.claimRun(run.id, 'first')).toBe(true);
});
it('claims queued work in creation order instead of letting newer callers jump ahead', () => {
  const { first, second, create } = sharedLibrary(); const runs = [create(), create(), create(), create()];
  first.claimRun(runs[0].id, 'first'); second.claimRun(runs[1].id, 'second');
  first.transitionRun(runs[0].id, 'completed');
  expect(second.claimRun(runs[3].id, 'second')).toBe(false);
  expect(first.claimRun(runs[2].id, 'first')).toBe(true);
});
it('bounds pending answer consultations without blocking context handoffs', () => {
  const { first, create } = sharedLibrary();
  for (let index = 0; index < 10; index++) create('first');
  expect(() => create('first')).toThrow('queue is full');
  const specialist = first.specialists()[0];
  expect(first.createConsultation({ specialistId: specialist.id, question: 'What happened?', mode: 'context', cli: 'codex', evidence: [], context: 'Test' }).mode).toBe('context');
});
