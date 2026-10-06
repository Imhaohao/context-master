import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const projectRoot = process.cwd();
const testDataDirectory = path.join(projectRoot, 'test-results', 'e2e-library');
const generatedAgentRulesPath = path.join(projectRoot, 'AGENTS.md');
const hadAgentRulesBeforeTests = fs.existsSync(generatedAgentRulesPath);
const agentRulesStartMarker = '<!-- BEGIN:nextjs-agent-rules -->';
const agentRulesEndMarker = '<!-- END:nextjs-agent-rules -->';

fs.rmSync(testDataDirectory, { force: true, recursive: true });
fs.mkdirSync(testDataDirectory, { recursive: true });

process.once('exit', () => {
  if (hadAgentRulesBeforeTests || !fs.existsSync(generatedAgentRulesPath)) return;
  const content = fs.readFileSync(generatedAgentRulesPath, 'utf8').trim();
  const end = content.indexOf(agentRulesEndMarker);
  if (content.startsWith(agentRulesStartMarker) && end >= 0 && content.slice(end + agentRulesEndMarker.length).trim() === '') {
    fs.rmSync(generatedAgentRulesPath, { force: true });
  }
});

const serverEnvironment = {
  ...process.env,
  CONTEXT_MASTER_DATA_DIR: testDataDirectory,
  NEXT_TELEMETRY_DISABLED: '1',
} as Record<string, string>;
delete serverEnvironment.CONTEXT_MASTER_TOKEN;
delete serverEnvironment.ELECTRON_RUN_AS_NODE;

export default defineConfig({
  expect: { timeout: 7_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  outputDir: path.join('test-results', 'playwright-output'),
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'test-results/playwright-report' }]],
  retries: 0,
  testDir: './tests/e2e',
  timeout: 45_000,
  use: {
    baseURL: 'http://127.0.0.1:3231',
    colorScheme: 'dark',
    locale: 'en-US',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --hostname 127.0.0.1 --port 3231',
    env: serverEnvironment,
    reuseExistingServer: false,
    timeout: 120_000,
    url: 'http://127.0.0.1:3231',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
