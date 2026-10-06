import type { LibraryStore } from './store';
import { draftBrief } from './context';
const examples = [
  {
    title: 'Database migrations', project: 'Example: Atlas', source: 'claude',
    goal: 'We need a safe way to migrate the Atlas SQLite library without losing saved sessions. How should migration and concurrent editing work?',
    answer: 'Use a numbered schema version in PRAGMA user_version. Apply each migration inside BEGIN IMMEDIATE so either every schema change succeeds or the transaction rolls back. Refuse to open databases from a newer app version. For concurrent specialist edits, send the current revision with the update and reject an outdated revision with a conflict response. Never overwrite another window’s edits silently. This is a design note from an example session, not proof of a production rollout.'
  },
  {
    title: 'Agent process lifecycle', project: 'Example: Atlas', source: 'codex',
    goal: 'How should a desktop harness start a specialist process, cancel it, and recover after the app crashes?',
    answer: 'Spawn the CLI with an argument array and shell disabled. Use an isolated working directory and disable tool execution. Record queued, running, completed, failed, and cancelled states. Give each run a heartbeat so another process can tell whether it was abandoned. Cancellation must stop the whole child process group, clear timers, and remove the temporary working directory. A late answer must never change a cancelled run back to completed. Keep a bounded output buffer and a timeout. These notes describe an example design; verify the CLI behavior before using it.'
  },
  {
    title: 'Accessible workspace UI', project: 'Example: Orchard', source: 'cursor',
    goal: 'What should we check before releasing our keyboard-driven desktop workspace?',
    answer: 'Use native buttons and labels so keyboard and screen-reader behavior starts with the platform. Every focusable control needs a visible focus indicator. Dialogs must move focus inside, trap it while open, close on Escape, and restore focus to the trigger. Test the whole import-to-consultation flow without a mouse. Under reduced motion, keep the final selected state visible without animation. At narrow widths and 200% zoom, keep the composer, source links, and cancellation control reachable. This example session records planned checks; it does not claim they passed.'
  },
  {
    title: 'Context routing', project: 'Example: Orchard', source: 'opencode',
    goal: 'How do we find a useful specialist without flooding the caller’s context window?',
    answer: 'Search each specialist’s name, scope, tags, and linked source messages. Use the score only to rank lexical matches; do not display it as a probability that the specialist is correct. Send a bounded brief and a small evidence bundle. Every excerpt should link back to an exact source message. Offer a context-only handoff when the caller wants to reason itself. Saved notes can be outdated, so the answering specialist should say when it lacks current evidence. Compression saves space but can omit useful details; let the person inspect and edit the brief.'
  }
];
export function loadExamples(store: LibraryStore) {
  return examples.map(example => {
    const imported = store.import(JSON.stringify({ ...example, messages: [{ role: 'user', content: example.goal }, { role: 'assistant', content: example.answer }] }), `${example.title}.json`);
    const session = imported.sessions[0];
    const existing = store.specialists().find(specialist => specialist.sessionIds.includes(session.id));
    if (existing) return existing;
    const draft = draftBrief([store.session(session.id)]);
    return store.createSpecialist({ ...draft, name: example.title, description: example.goal, tags: ['example', ...draft.tags], cli: 'codex', sessionIds: [session.id] });
  });
}
