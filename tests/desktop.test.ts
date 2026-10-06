import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';

function exists(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(25);
  }
  throw new Error('Timed out waiting for backend process cleanup.');
}
function readPids(file: string): number[] {
  try { return JSON.parse(readFileSync(file, 'utf8')) as number[]; } catch { return []; }
}
function stop(child?: ChildProcess, pids: number[] = []) {
  child?.kill('SIGKILL');
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

it.skipIf(process.platform === 'win32')('stops the native backend and its descendants when the app owner crashes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'context-master-desktop-'));
  const pidFile = join(directory, 'pids.json');
  const backendFile = join(directory, 'backend.cjs');
  writeFileSync(backendFile, `const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.ppid, process.pid, child.pid]));
    setInterval(() => {}, 1000);`);
  const owner = spawn(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath,
    [${JSON.stringify(resolve('desktop/backend.cjs'))}, ${JSON.stringify(backendFile)}],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); setInterval(() => {}, 1000);`], { stdio: 'ignore' });
  let pids: number[] = [];
  try {
    await until(() => readPids(pidFile).length === 3);
    pids = readPids(pidFile);
    expect(pids.every(exists)).toBe(true);
    owner.kill('SIGKILL');
    await until(() => pids.every(pid => !exists(pid)));
  } finally { stop(owner, pids); rmSync(directory, { recursive: true, force: true }); }
});
