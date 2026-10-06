import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/core/database';
import { LibraryStore } from '../src/core/store';
import { draftBrief, matchSpecialists, selectEvidence, validateCitations } from '../src/core/context';
import { redactCredentials } from '../src/core/redaction';
const stores: LibraryStore[] = [];
function store() { const result = new LibraryStore(openDatabase(':memory:')); stores.push(result); return result; }
const transcript = JSON.stringify({ title: 'SQLite concurrency', messages: [
  { role: 'user', content: 'How do we prevent SQLite update races?' },
  { role: 'assistant', content: 'Use BEGIN IMMEDIATE for writes and revision checks for concurrent edits.' }
] });
function setup() {
  const library = store(); const session = library.import(transcript, 'session.json').sessions[0];
  const draft = draftBrief([library.session(session.id)]);
  const specialist = library.createSpecialist({ ...draft, cli: 'claude', sessionIds: [session.id] });
  return { library, session, specialist };
}
afterEach(() => { stores.splice(0).forEach(item => item.close()); });
describe('library invariants', () => {
  it('imports idempotently and preserves exact source messages', () => {
    const library = store(); const first = library.import(transcript, 'one.json'); const second = library.import(transcript, 'two.json');
    expect(second.duplicates).toBe(1); expect(second.sessions[0].id).toBe(first.sessions[0].id);
    expect(library.session(first.sessions[0].id).messages).toHaveLength(2);
  });
  it('redacts credentials before persistence and export', () => {
    const library = store(); const result = library.import(JSON.stringify({ messages: [{ role: 'user', content: 'api_key=superSecretValue123456789' }] }), 'secret.json');
    expect(result.redactions).toBe(1);
    expect(library.session(result.sessions[0].id).messages[0].text).not.toContain('superSecretValue');
    expect(redactCredentials('Nothing sensitive').count).toBe(0);
  });
  it('redacts session metadata and specialist fields', () => {
    const library = store(); const secret = 'api_key=superSecretValue123456789';
    const session = library.import(JSON.stringify({ title: secret, externalId: secret, project: secret, messages: [{ role: 'user', content: 'Synthetic message' }] }), 'secret.json').sessions[0];
    expect(JSON.stringify(session)).not.toContain('superSecretValue');
    const specialist = library.createSpecialist({ name: secret, description: secret, brief: secret, tags: [secret], cli: 'codex', sessionIds: [session.id] });
    expect(JSON.stringify(specialist)).not.toContain('superSecretValue');
  });
  it('rejects stale specialist edits without losing revisions', () => {
    const { library, specialist } = setup(); const edit = { ...specialist, name: 'Database specialist' };
    const saved = library.updateSpecialist(specialist.id, edit); expect(saved.revision).toBe(2);
    expect(() => library.updateSpecialist(specialist.id, edit)).toThrow('another window');
    expect(library.versions(specialist.id).map(item => item.name)).toEqual(['Database specialist', specialist.name]);
  });
  it('rolls back specialist creation when a source does not exist', () => {
    const { library, specialist } = setup();
    expect(() => library.createSpecialist({ ...specialist, sessionIds: ['00000000-0000-4000-8000-000000000001'] })).toThrow('Session not found');
    expect(library.specialists()).toHaveLength(1);
  });
  it('protects linked sources from deletion and excludes archived specialists from routing', () => {
    const { library, session, specialist } = setup();
    expect(() => library.deleteSession(session.id)).toThrow('supports a specialist');
    library.archiveSpecialist(specialist.id, true);
    expect(matchSpecialists(library, 'SQLite concurrency')).toHaveLength(0);
  });
  it('matches source evidence and returns citations that resolve to exact messages', () => {
    const { library, specialist } = setup(); const matches = matchSpecialists(library, 'SQLite races');
    expect(matches[0].specialist.id).toBe(specialist.id);
    const evidence = selectEvidence(library, specialist, 'revision checks');
    expect(evidence[0].quote).toContain('revision checks');
    const message = library.session(evidence[0].sessionId).messages[evidence[0].ordinal];
    expect(message.id).toBe(evidence[0].id); expect(message.text).toContain(evidence[0].quote);
  });
  it('does not treat SQLite search syntax as executable query syntax', () => {
    const { library } = setup(); expect(() => matchSpecialists(library, '" OR * : NOT <script>')).not.toThrow();
  });
  it('validates model references instead of inventing missing citations', () => {
    const result = validateCitations('Known [1], invented [999].', [{ id: 'source' } as never]);
    expect(result.invalid).toBe(true); expect(result.answer).toBe('Known [1], invented [unsupported source].');
  });
  it('never resurrects a cancelled run on late completion', () => {
    const { library, specialist } = setup(); const run = library.createConsultation({ specialistId: specialist.id, question: 'Why?', mode: 'answer', cli: 'claude', context: 'packet', evidence: [] });
    library.transitionRun(run.id, 'running'); library.transitionRun(run.id, 'cancelled'); library.transitionRun(run.id, 'completed', { answer: 'Late output' });
    expect(library.consultation(run.id).status).toBe('cancelled'); expect(library.consultation(run.id).answer).toBe('');
  });
});
