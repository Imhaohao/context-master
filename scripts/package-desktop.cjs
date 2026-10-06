'use strict';

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const root = path.resolve(__dirname, '..');
const standaloneSource = path.join(root, '.next', 'standalone');
const staticSource = path.join(root, '.next', 'static');
const publicSource = path.join(root, 'public');
const desktopBundle = path.join(root, 'desktop-bundle');
const agentBundle = path.join(root, 'agent-bundle');
const desktopApp = path.join(root, 'desktop-app');

function requirePath(source, label) {
  if (!fs.existsSync(source)) {
    throw new Error(`Cannot package desktop app: ${label} is missing at ${source}. Run npm run build first.`);
  }
}

function copyPath(source, destination, label) {
  requirePath(source, label);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

async function bundleAgentEntry(esbuild, source, output) {
  const sourcePath = path.join(root, source);
  requirePath(sourcePath, `agent entrypoint ${source}`);
  await esbuild.build({
    bundle: true,
    entryPoints: [sourcePath],
    external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    format: 'cjs',
    logLevel: 'info',
    outfile: path.join(agentBundle, output),
    packages: 'bundle',
    platform: 'node',
    sourcemap: false,
    target: 'node22',
  });
}

async function packageDesktop() {
  const esbuild = require('esbuild');
  fs.rmSync(desktopBundle, { force: true, recursive: true });
  fs.rmSync(agentBundle, { force: true, recursive: true });
  fs.mkdirSync(desktopBundle, { recursive: true });
  fs.mkdirSync(agentBundle, { recursive: true });

  for (const entry of ['server.js', 'package.json', '.next', 'node_modules']) {
    copyPath(path.join(standaloneSource, entry), path.join(desktopBundle, entry), `Next runtime ${entry}`);
  }
  copyPath(staticSource, path.join(desktopBundle, '.next', 'static'), 'Next static assets');
  if (fs.existsSync(publicSource)) copyPath(publicSource, path.join(desktopBundle, 'public'), 'public assets');
  await bundleAgentEntry(esbuild, 'scripts/mcp.ts', 'mcp.cjs');
  await bundleAgentEntry(esbuild, 'scripts/cli.ts', 'cli.cjs');
  fs.rmSync(desktopApp, { force: true, recursive: true });
  fs.mkdirSync(desktopApp, { recursive: true });
  fs.cpSync(path.join(root, 'desktop'), path.join(desktopApp, 'desktop'), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(desktopApp, 'package.json'), JSON.stringify({
    name: manifest.name, productName: 'Context Master', version: manifest.version,
    description: manifest.description, main: 'desktop/main.cjs', private: true,
  }, null, 2));
  process.stdout.write('Desktop bundles prepared in desktop-bundle/ and agent-bundle/.\n');
}

packageDesktop().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
