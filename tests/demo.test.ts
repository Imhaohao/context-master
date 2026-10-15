import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/core/database';
import { LibraryStore } from '../src/core/store';
import { loadExamples } from '../src/core/demo';
import { matchSpecialists, selectEvidence } from '../src/core/context';
const stores: LibraryStore[] = [];
function store() { const result = new LibraryStore(openDatabase(':memory:')); stores.push(result); return result; }
afterEach(() => { stores.splice(0).forEach(item => item.close()); });
describe('example library', () => {
  it('builds the three example specialists once, answering with the chosen CLI', () => {
    const library = store();
    const first = loadExamples(library, 'claude');
    const second = loadExamples(library, 'codex');
    expect(first.map(item => item.name)).toEqual(['Tidepool payments', 'Tidepool database', 'Tidepool reminders']);
    expect(second.map(item => item.id)).toEqual(first.map(item => item.id));
    expect(library.specialists()).toHaveLength(3);
    expect(library.library().sessions).toHaveLength(4);
    expect(first.every(item => item.cli === 'claude' && item.tags.includes('example'))).toBe(true);
  });

  it('routes a payments question to the payments specialist with evidence from its chats', () => {
    const library = store();
    loadExamples(library, 'claude');
    const question = 'A student got two confirmation emails for one Stripe charge. Why?';
    const [best] = matchSpecialists(library, question, 3);
    expect(best.specialist.name).toBe('Tidepool payments');
    const evidence = selectEvidence(library, best.specialist, question);
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.some(item => item.sessionTitle === 'Stripe webhooks arriving twice')).toBe(true);
  });
});
