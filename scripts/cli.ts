import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { SpecialistService } from '../src/core/service';
import { discoverSessions, loadDiscoveredSession } from '../src/core/discovery';
import { draftBrief } from '../src/core/context';
import { cliSchema } from '../src/core/validation';
const usage = `Context Master\n\nCommands:\n  scan                       List native saved sessions without importing them\n  import <file>              Import a transcript file into the local library\n  import-session <id>         Import a session ID returned by scan\n  specialists [question]     List or search specialists\n  create <session-id> <name>  Create a specialist from an imported session\n  context <id> <question>     Return a context handoff without calling a model\n  ask <id> <question> [cli]   Ask using claude, codex, opencode, or cursor\n  library                    Show library metadata\n\nRun with npm run cli -- <command>. The app and CLI use the same local database.\n`;
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') { process.stdout.write(usage); return; }
  const app = new SpecialistService();
  process.once('SIGINT', () => void app.shutdown()); process.once('SIGTERM', () => void app.shutdown());
  try { output(await execute(app, command, args)); }
  finally { await app.shutdown(); app.store.close(); }
}
async function execute(app: SpecialistService, command: string, args: string[]): Promise<unknown> {
  switch (command) {
    case 'scan': return discoverSessions();
    case 'library': return app.store.library();
    case 'import': { const filename = resolve(required(args[0], 'Transcript file path')); return app.store.import(await readFile(filename, 'utf8'), basename(filename)); }
    case 'import-session': { const file = await loadDiscoveredSession(required(args[0], 'Discovered session ID')); return app.store.import(file.text, file.name); }
    case 'specialists': return app.search(args.join(' '), 20);
    case 'create': { const id = required(args[0], 'Imported session ID'); const draft = draftBrief([app.store.session(id)]); return app.store.createSpecialist({ ...draft, name: required(args[1], 'Specialist name'), cli: 'codex', sessionIds: [id] }); }
    case 'context': return app.start({ specialistId: required(args[0], 'Specialist ID'), question: required(args[1], 'Question'), mode: 'context' });
    case 'ask': { const run = app.start({ specialistId: required(args[0], 'Specialist ID'), question: required(args[1], 'Question'), mode: 'answer', ...(args[2] ? { cli: cliSchema.parse(args[2]) } : {}) }); const completed = await app.wait(run.id); if (completed.status !== 'completed') process.exitCode = 1; return completed; }
    default: throw new Error(`Unknown command: ${command}\n${usage}`);
  }
}
function required(value: string | undefined, label: string) { if (!value) throw new Error(`${label} is required. Use --help for examples.`); return value; }
function output(value: unknown) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Context Master failed.'}\n`); process.exitCode = 1; });
