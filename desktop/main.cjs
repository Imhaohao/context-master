'use strict';

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
} = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { TextDecoder } = require('util');
const { spawn } = require('child_process');

app.setName('Context Master');
if (process.platform === 'darwin') app.setPath('userData', path.join(app.getPath('appData'), 'Context Master'));

const HOST = '127.0.0.1';
const DEFAULT_DEV_PORT = 3210;
const PICK_FILES_CHANNEL = 'context-master:pick-files';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 20;
const MAX_DIAGNOSTIC_BYTES = 128 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.json', '.jsonl', '.txt', '.md']);

let mainWindow;
let backendProcess;
let serverUrl;
let sessionToken;
let cleanupPromise;
let quitAfterCleanup = false;

function isProduction() {
  return app.isPackaged;
}

function diagnosticPath() {
  if (!isProduction()) return undefined;
  return path.join(app.getPath('userData'), 'logs', 'context-master.log');
}

function writeDiagnostic(message) {
  const filePath = diagnosticPath();
  if (!filePath) return;

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const safeMessage = String(message).replace(/[\r\n]+/gu, ' ').slice(0, 500);
    const line = `${new Date().toISOString()} ${safeMessage}\n`;
    let current = '';
    try {
      current = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const next = `${current}${line}`;
    const bytes = Buffer.byteLength(next, 'utf8');
    const retained = bytes > MAX_DIAGNOSTIC_BYTES
      ? next.slice(-Math.floor(MAX_DIAGNOSTIC_BYTES / 2))
      : next;
    fs.writeFileSync(filePath, retained, 'utf8');
  } catch {
    // Diagnostics must never prevent the app from starting or quitting.
  }
}

function normalizedServerUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('The local server URL is invalid.');
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== HOST || !parsed.port) {
    throw new Error('The local server must bind to 127.0.0.1 over HTTP.');
  }
  return `http://${HOST}:${parsed.port}`;
}

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
    if (childProcess && childProcess.exitCode !== null) {
      throw new Error('The local web server exited before it was ready.');
    }
    if (await requestServer(url)) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(Math.round(delayMs * 1.4), 750);
  }
  throw new Error('The local web server did not become ready within 20 seconds.');
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error('Unable to allocate a local server port.'));
          return;
        }
        resolve(port);
      });
    });
  });
}

function consumeBackendOutput(childProcess) {
  childProcess.stdout?.resume();
  childProcess.stderr?.resume();
}

async function startProductionBackend() {
  const webRoot = path.join(process.resourcesPath, 'web');
  const serverPath = path.join(webRoot, 'server.js');
  if (!fs.existsSync(serverPath)) {
    throw new Error('The packaged web server is missing. Run the desktop packaging step again.');
  }

  const port = await getFreePort();
  const dataDirectory = process.env.CONTEXT_MASTER_DATA_DIR || app.getPath('userData');
  sessionToken = crypto.randomBytes(32).toString('base64url');
  const environment = {
    ...process.env,
    CONTEXT_MASTER_DATA_DIR: dataDirectory,
    CONTEXT_MASTER_TOKEN: sessionToken,
    CONTEXT_MASTER_NODE: process.execPath,
    CONTEXT_MASTER_MCP_ENTRY: path.join(process.resourcesPath, 'agent', 'mcp.cjs'),
    ELECTRON_RUN_AS_NODE: '1',
    HOST: HOST,
    HOSTNAME: HOST,
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_ENV: 'production',
    PORT: String(port),
  };

  backendProcess = spawn(process.execPath, [path.join(__dirname, 'backend.cjs'), serverPath], {
    cwd: webRoot,
    detached: process.platform !== 'win32',
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  consumeBackendOutput(backendProcess);
  backendProcess.once('error', (error) => {
    writeDiagnostic(`backend process error: ${error.code || 'unknown'}`);
  });
  backendProcess.once('exit', (code, signal) => {
    writeDiagnostic(`backend process exit: code=${code ?? 'none'} signal=${signal ?? 'none'}`);
  });

  serverUrl = `http://${HOST}:${port}`;
  await waitForServer(serverUrl, backendProcess);
  writeDiagnostic('backend ready');
}

async function startDevelopmentBackend() {
  const configuredUrl = process.env.CONTEXT_MASTER_DEV_SERVER_URL
    || `http://${HOST}:${process.env.CONTEXT_MASTER_DEV_PORT || DEFAULT_DEV_PORT}`;
  serverUrl = normalizedServerUrl(configuredUrl);
  await waitForServer(serverUrl);
}

async function startBackend() {
  if (isProduction()) {
    await startProductionBackend();
    return;
  }
  await startDevelopmentBackend();
}

function appOrigin() {
  return serverUrl ? new URL(serverUrl).origin : undefined;
}

function isAppUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.origin === appOrigin() && parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function openExternalHttpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  const localHostnames = new Set([HOST, 'localhost', '[::1]']);
  if (
    !['http:', 'https:'].includes(parsed.protocol)
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || localHostnames.has(parsed.hostname)
      || isAppUrl(rawUrl)
  ) return;
  void shell.openExternal(parsed.toString()).catch(() => undefined);
}

function configureNavigation(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalHttpUrl(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternalHttpUrl(url);
  });
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

function validRenderer(event) {
  return Boolean(
    mainWindow
      && event.sender === mainWindow.webContents
      && event.senderFrame
      && isAppUrl(event.senderFrame.url),
  );
}

function allowedFile(filePath) {
  return ALLOWED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function readUtf8File(filePath) {
  if (!allowedFile(filePath)) {
    throw new Error('Only .json, .jsonl, .txt, and .md files can be imported.');
  }
  const fileInfo = await fs.promises.stat(filePath);
  if (!fileInfo.isFile()) throw new Error('Each selected import must be a regular file.');
  if (fileInfo.size > MAX_FILE_BYTES) throw new Error('Each imported file must be 8 MB or smaller.');

  const bytes = await fs.promises.readFile(filePath);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Imported files must contain valid UTF-8 text.');
  }
}

async function readSelectedFiles(filePaths) {
  if (filePaths.length > MAX_FILES) throw new Error('Select 20 files or fewer at a time.');
  return Promise.all(filePaths.map(async (filePath) => ({
    name: path.basename(filePath),
    text: await readUtf8File(filePath),
  })));
}

async function pickFiles(event) {
  if (!validRenderer(event)) throw new Error('Only the Context Master window may open the file picker.');
  const result = await dialog.showOpenDialog(mainWindow, {
    buttonLabel: 'Import sessions',
    filters: [{ extensions: ['json', 'jsonl', 'txt', 'md'], name: 'Session files' }],
    properties: ['openFile', 'multiSelections'],
    title: 'Import agent sessions',
  });
  if (result.canceled) return [];
  return readSelectedFiles(result.filePaths);
}

function createMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [{ role: 'close' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    {
      label: 'Window',
      role: 'windowMenu',
    },
    {
      label: 'Help',
      submenu: [],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    backgroundColor: '#101214',
    height: 820,
    minHeight: 520,
    minWidth: 720,
    show: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
    },
    width: 1280,
  });
  configureNavigation(mainWindow);
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });

  if (sessionToken) {
    await mainWindow.webContents.session.cookies.set({
      httpOnly: true,
      name: 'cm_session',
      path: '/',
      sameSite: 'strict',
      secure: false,
      url: serverUrl,
      value: sessionToken,
    });
  }
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  await mainWindow.loadURL(serverUrl);
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

function stopSpecialists() {
  if (!serverUrl || !sessionToken) return Promise.resolve();
  return new Promise((resolve) => {
    const request = http.request(`${serverUrl}/api/shutdown`, {
      method: 'POST', headers: { authorization: `Bearer ${sessionToken}` },
    }, (response) => { response.resume(); response.on('end', resolve); });
    request.setTimeout(4000, () => request.destroy());
    request.once('error', resolve); request.end();
  });
}
async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = stopSpecialists().then(() => stopProcess(backendProcess)).finally(() => {
    backendProcess = undefined;
    sessionToken = undefined;
    writeDiagnostic('app cleanup complete');
  });
  return cleanupPromise;
}

function requestQuit() {
  if (quitAfterCleanup) return;
  quitAfterCleanup = true;
  void cleanup().finally(() => app.quit());
}

function installLifecycle() {
  app.on('before-quit', (event) => {
    if (quitAfterCleanup) return;
    event.preventDefault();
    requestQuit();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (!mainWindow && serverUrl) void createWindow();
  });
  process.once('SIGTERM', requestQuit);
  process.once('SIGINT', requestQuit);
}

async function launch() {
  await app.whenReady();
  createMenu();
  await startBackend();
  ipcMain.handle(PICK_FILES_CHANNEL, pickFiles);
  await createWindow();
}

async function reportStartupFailure(error) {
  const message = error instanceof Error ? error.message : 'Unknown startup error.';
  writeDiagnostic(`startup failure: ${message}`);
  await dialog.showMessageBox({
    detail: 'Check the local Context Master log in the application data folder for diagnostics.',
    message,
    title: 'Context Master could not start',
    type: 'error',
  });
  requestQuit();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  installLifecycle();
  void launch().catch(reportStartupFailure);
}
