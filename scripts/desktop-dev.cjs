'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 3210;

function requestServer(url, timeoutMs = 750) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(true);
    });
    request.setTimeout(timeoutMs, () => request.destroy());
    request.once('error', () => resolve(false));
  });
}

async function waitForServer(url, childProcess) {
  const deadline = Date.now() + 20_000;
  let delayMs = 100;
  while (Date.now() < deadline) {
    if (childProcess.exitCode !== null) {
      throw new Error('The Next.js development server exited before it was ready.');
    }
    if (await requestServer(url)) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(Math.round(delayMs * 1.4), 750);
  }
  throw new Error('The Next.js development server did not become ready within 20 seconds.');
}

function stopProcess(childProcess) {
  return new Promise((resolve) => {
    if (!childProcess || childProcess.exitCode !== null) {
      resolve();
      return;
    }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    childProcess.once('exit', finish);
    const signal = (name) => {
      try {
        if (process.platform === 'win32') childProcess.kill(name);
        else process.kill(-childProcess.pid, name);
      } catch {
        try {
          childProcess.kill(name);
        } catch {
          finish();
        }
      }
    };
    signal('SIGTERM');
    setTimeout(() => {
      if (!finished) signal('SIGKILL');
    }, 3_000).unref();
    setTimeout(finish, 3_500).unref();
  });
}

function waitForExit(childProcess) {
  return new Promise((resolve) => {
    childProcess.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function developmentEnvironment() {
  const environment = {
    ...process.env,
    CONTEXT_MASTER_DEV_PORT: String(PORT),
    CONTEXT_MASTER_DEV_SERVER_URL: `http://${HOST}:${PORT}`,
    HOST: HOST,
    HOSTNAME: HOST,
    NEXT_TELEMETRY_DISABLED: '1',
    PORT: String(PORT),
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

async function run() {
  const root = path.resolve(__dirname, '..');
  const nextCli = require.resolve('next/dist/bin/next');
  const environment = developmentEnvironment();
  const nextProcess = spawn(process.execPath, [nextCli, 'dev', '--hostname', HOST, '--port', String(PORT)], {
    cwd: root,
    detached: process.platform !== 'win32',
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  });
  let electronProcess;
  let stopping = false;
  const stopAll = async () => {
    if (stopping) return;
    stopping = true;
    await stopProcess(electronProcess);
    await stopProcess(nextProcess);
  };
  const onSignal = (signal) => {
    void stopAll().finally(() => {
      process.exitCode = signal === 'SIGINT' ? 130 : 143;
    });
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  try {
    await waitForServer(`http://${HOST}:${PORT}`, nextProcess);
    electronProcess = spawn(require('electron'), [root], {
      cwd: root,
      env: environment,
      stdio: 'inherit',
      windowsHide: true,
    });
    const electronExit = waitForExit(electronProcess);
    const nextExit = waitForExit(nextProcess);
    const firstExit = await Promise.race([
      electronExit.then((result) => ({ kind: 'electron', result })),
      nextExit.then((result) => ({ kind: 'next', result })),
    ]);
    if (firstExit.kind === 'next' && !stopping) {
      throw new Error('The Next.js development server stopped while Electron was running.');
    }
    if (firstExit.kind === 'electron') {
      process.exitCode = firstExit.result.code ?? 1;
    }
  } finally {
    await stopAll();
  }
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
