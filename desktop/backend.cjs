'use strict';

const { spawn } = require('node:child_process');

function stopGroup() {
  try { process.kill(-process.pid, 'SIGKILL'); }
  catch { process.exit(1); }
}

function main() {
  if (!process.connected || !process.argv[2]) {
    throw new Error('The backend must be started by the Context Master app.');
  }
  process.once('disconnect', stopGroup);
  const backend = spawn(process.execPath, [process.argv[2]], {
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  backend.once('error', stopGroup);
  backend.once('exit', stopGroup);
}

main();
