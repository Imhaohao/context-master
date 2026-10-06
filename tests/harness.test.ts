import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getCliStatuses, runSpecialist, type AgentCli } from "../src/core/harness";

const originalPath = process.env.PATH ?? "";
const roots: string[] = [];
let fakeBin = "";

const CODEX_FEATURE_NAMES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode_host",
  "computer_use",
  "image_generation",
  "in_app_browser",
  "mcp_2026_07_28",
  "plugins",
  "shell_snapshot",
  "shell_tool",
  "unified_exec",
  "view_image",
  "workspace_dependencies",
  "removed_feature",
];

const CODEX_FEATURE_INVENTORY = [
  ...CODEX_FEATURE_NAMES.filter((name) => name !== "removed_feature").map((name) => `${name} stable true`),
  "removed_feature removed false",
].join("\n");

beforeEach(async () => {
  fakeBin = await mkdtemp(join(tmpdir(), "context-master-harness-test-"));
  roots.push(fakeBin);
  await Promise.all([
    createFakeCli("claude", "Claude Code fake 1.0"),
    createFakeCli("codex", "Codex fake 1.0"),
    createFakeCli("opencode", "OpenCode fake 1.0"),
    createFakeCli("agent", "Cursor Agent fake 1.0"),
  ]);
  process.env.PATH = `${fakeBin}${delimiter}${originalPath}`;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  delete process.env.CONTEXT_MASTER_TOKEN;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.NODE_OPTIONS;
  delete process.env.CODEX_HOME;
  delete process.env.HARNESS_ARGS_FILE;
  delete process.env.HARNESS_AUTH_ERROR;
  delete process.env.HARNESS_API_ONLY;
  delete process.env.HARNESS_ENV_FILE;
  delete process.env.HARNESS_FEATURES_MODE;
  delete process.env.HARNESS_DESCENDANT_PID_FILE;
  delete process.env.HARNESS_EXIT_AFTER_OUTPUT;
  delete process.env.HARNESS_TEST_WAIT;
  delete process.env.HARNESS_CWD_FILE;
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

describe("specialist CLI harness", () => {
  it("discovers installed CLIs and verifies their advertised safety flags", async () => {
    const statuses = await getCliStatuses();
    expect(statuses.map(({ id }) => id)).toEqual(["claude", "codex", "opencode", "cursor"]);
    expect(statuses.filter(({ id }) => id === "claude" || id === "codex").every(({ installed, detail }) => installed && detail?.includes("subscription auth verified"))).toBe(true);
    expect(statuses.filter(({ id }) => id === "claude" || id === "codex" || id === "opencode").every(({ ready }) => ready)).toBe(true);
    expect(statuses.find(({ id }) => id === "cursor")).toMatchObject({ installed: true, ready: false });
    expect(statuses.find(({ id }) => id === "cursor")?.detail).toContain("Unsupported for no-tool specialists");
  });

  it("marks an installed CLI as blocked when only API credentials are available", async () => {
    process.env.HARNESS_API_ONLY = "1";

    const statuses = await getCliStatuses();
    expect(statuses.find(({ id }) => id === "opencode")).toMatchObject({ installed: true, ready: false });
    expect(statuses.find(({ id }) => id === "opencode")?.detail).toContain("subscription auth unverified");
  });

  it("fails closed when the Codex feature inventory is malformed or incomplete", async () => {
    process.env.HARNESS_FEATURES_MODE = "malformed";
    const malformed = await getCliStatuses();
    expect(malformed.find(({ id }) => id === "codex")).toMatchObject({ installed: true, ready: false });
    expect(malformed.find(({ id }) => id === "codex")?.detail).toContain("feature inventory is malformed");

    process.env.HARNESS_FEATURES_MODE = "insufficient";
    const insufficient = await getCliStatuses();
    expect(insufficient.find(({ id }) => id === "codex")).toMatchObject({ installed: true, ready: false });
    expect(insufficient.find(({ id }) => id === "codex")?.detail).toContain("feature inventory is incomplete");
  });

  it("runs each adapter in a temporary workspace and strips API-key variables", async () => {
    process.env.OPENAI_API_KEY = "must-not-reach-child";
    const inputs: AgentCli[] = ["claude", "codex", "opencode"];
    const results = await Promise.all(inputs.map((cli) => runSpecialist({ cli, prompt: `question for ${cli}` })));

    for (const [index, result] of results.entries()) {
      expect(result.cli).toBe(inputs[index]);
      expect(result.text).toContain(`question for ${inputs[index]}`);
      expect(result.text).toContain("key:absent");
      const cwd = result.text.match(/cwd:(.*)\|key:/u)?.[1];
      expect(cwd).toBeTruthy();
      expect(existsSync(cwd ?? "")).toBe(false);
    }
    delete process.env.OPENAI_API_KEY;
  });

  it("passes the exact no-tool safety contract to each CLI", async () => {
    const argsFile = join(fakeBin, "args.json");
    process.env.HARNESS_ARGS_FILE = argsFile;
    for (const cli of ["claude", "codex", "opencode"] as AgentCli[]) {
      await runSpecialist({ cli, prompt: "contract check" });
      const invocation = JSON.parse(await readFile(argsFile, "utf8")) as { args: string[]; config?: Record<string, unknown> };
      if (cli === "claude") {
        expect(invocation.args).toEqual(expect.arrayContaining(["--tools", "", "--safe-mode", "--strict-mcp-config", "--no-session-persistence"]));
      } else if (cli === "codex") {
        expect(invocation.args).toEqual(expect.arrayContaining([
          "--strict-config",
          "-c",
          'approval_policy="never"',
          'web_search="disabled"',
          "tools.experimental_request_user_input.enabled=false",
          "tools.update_plan.enabled=false",
          "--sandbox",
          "read-only",
        ]));
        for (const feature of CODEX_FEATURE_NAMES.filter((name) => name !== "removed_feature")) {
          expect(invocation.args).toContain("--disable");
          expect(invocation.args).toContain(feature);
        }
        expect(invocation.args).not.toContain("removed_feature");
      } else if (cli === "opencode") {
        expect(invocation.args).toEqual(expect.arrayContaining(["--pure", "--format", "json", "--prompt"]));
        expect(invocation.config?.permission).toEqual({ "*": "deny" });
        expect(invocation.config?.tools).toMatchObject({ bash: false, edit: false, read: false, write: false });
      }
    }
  });

  it("passes only safe child environment variables and preserves Codex auth home", async () => {
    const environmentFile = join(fakeBin, "environment.json");
    process.env.HARNESS_ENV_FILE = environmentFile;
    process.env.CONTEXT_MASTER_TOKEN = "app-bearer-token";
    process.env.OPENAI_API_KEY = "openai-api-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "anthropic-token";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-secret";
    process.env.NODE_OPTIONS = "--require=bad-module";
    process.env.CODEX_HOME = join(fakeBin, "codex-home");

    await runSpecialist({ cli: "codex", prompt: "environment check" });
    const childEnvironment = JSON.parse(await readFile(environmentFile, "utf8")) as Record<string, string>;
    expect(childEnvironment.CONTEXT_MASTER_TOKEN).toBeUndefined();
    expect(childEnvironment.OPENAI_API_KEY).toBeUndefined();
    expect(childEnvironment.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(childEnvironment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(childEnvironment.NODE_OPTIONS).toBeUndefined();
    expect(childEnvironment.CODEX_HOME).toBe(process.env.CODEX_HOME);
  });

  it("refuses Cursor because ask mode cannot deny every read/search tool", async () => {
    await expect(runSpecialist({ cli: "cursor", prompt: "unsupported" })).rejects.toThrow(/read\/search tools/);
  });

  it("refuses OpenCode when credentials only identify an API provider", async () => {
    process.env.HARNESS_API_ONLY = "1";
    await expect(runSpecialist({ cli: "opencode", prompt: "api provider" })).rejects.toThrow(/subscription auth is not verified/);
  });

  it("refuses an installed CLI when its safety guard is missing", async () => {
    const claude = join(fakeBin, "claude");
    await writeFile(claude, `#!${process.execPath}\nconsole.log("--print");\n`, { encoding: "utf8", mode: 0o700 });
    await expect(runSpecialist({ cli: "claude", prompt: "unsafe" })).rejects.toThrow(/Cannot safely run Claude Code/);
  });

  it("surfaces a structured authentication failure without tool or reasoning output", async () => {
    process.env.HARNESS_AUTH_ERROR = "1";
    await expect(runSpecialist({ cli: "claude", prompt: "auth error" })).rejects.toThrow(/Authentication required/);
  });

  it("cancels a child process and removes its temporary workspace", async () => {
    const cwdFile = join(fakeBin, "child-cwd.txt");
    process.env.HARNESS_TEST_WAIT = "1";
    process.env.HARNESS_CWD_FILE = cwdFile;
    const controller = new AbortController();
    const pending = runSpecialist({ cli: "claude", prompt: "wait", signal: controller.signal });
    setTimeout(() => controller.abort(), 1_000).unref();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const childCwd = await readFile(cwdFile, "utf8");
    expect(existsSync(childCwd)).toBe(false);
  });

  it("waits for process-group escalation before returning after a child exits", async () => {
    const descendantPidFile = join(fakeBin, "descendant.pid");
    process.env.HARNESS_DESCENDANT_PID_FILE = descendantPidFile;
    process.env.HARNESS_EXIT_AFTER_OUTPUT = "1";

    const result = await runSpecialist({ cli: "claude", prompt: "group cleanup" });
    expect(result.text).toContain("group cleanup");
    const descendantPid = Number(await readFile(descendantPidFile, "utf8"));
    expect(await waitForProcessExit(descendantPid)).toBe(true);
  });

  it("cleans the workspace and process group when the owning app dies", async () => {
    const cwdFile = join(fakeBin, "owner-death-cwd.txt");
    const descendantPidFile = join(fakeBin, "owner-death-descendant.pid");
    const runnerSource = `import { runSpecialist } from ${JSON.stringify(join(process.cwd(), "src/core/harness.ts"))}; await runSpecialist({ cli: "claude", prompt: "owner death" });`;
    const owner = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", runnerSource], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HARNESS_CWD_FILE: cwdFile,
        HARNESS_DESCENDANT_PID_FILE: descendantPidFile,
        NODE_ENV: "test",
        PATH: `${fakeBin}${delimiter}${originalPath}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      expect(await waitForFile(cwdFile)).toBe(true);
      expect(await waitForFile(descendantPidFile)).toBe(true);
      const childCwd = await readFile(cwdFile, "utf8");
      const descendantPid = Number(await readFile(descendantPidFile, "utf8"));
      owner.kill("SIGKILL");
      await waitForClose(owner);
      expect(await waitForAbsent(childCwd)).toBe(true);
      expect(await waitForProcessExit(descendantPid)).toBe(true);
    } finally {
      if (owner.exitCode === null) owner.kill("SIGKILL");
    }
  });
});

async function waitForFile(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return existsSync(path);
}

async function waitForAbsent(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !existsSync(path);
}

async function waitForClose(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may have exited between the check and cleanup.
    }
    return false;
  }
  return true;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function createFakeCli(name: string, version: string): Promise<void> {
  const script = `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log(${JSON.stringify(version)}); process.exit(0); }
if (${JSON.stringify(name)} === "claude" && args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" })); process.exit(0); }
if (${JSON.stringify(name)} === "codex" && args[0] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
if (${JSON.stringify(name)} === "opencode" && args[0] === "auth") { console.log(process.env.HARNESS_API_ONLY ? "Credentials\\n● OpenRouter api" : "Credentials\\n● ChatGPT oauth"); process.exit(0); }
if (${JSON.stringify(name)} === "agent" && args[0] === "status") { console.log(JSON.stringify({ isAuthenticated: true, authMethod: "subscription" })); process.exit(0); }
if (${JSON.stringify(name)} === "codex" && args[0] === "features") {
  const inventory = process.env.HARNESS_FEATURES_MODE === "malformed" ? "not a feature inventory" : process.env.HARNESS_FEATURES_MODE === "insufficient" ? "shell_tool stable true" : ${JSON.stringify(CODEX_FEATURE_INVENTORY)};
  console.log(inventory);
  process.exit(0);
}
if (args.includes("--help")) {
  if (${JSON.stringify(name)} === "codex") console.log("--disable <FEATURE> --sandbox <SANDBOX_MODE> --strict-config --ignore-user-config --ignore-rules --ephemeral");
  else if (${JSON.stringify(name)} === "claude") console.log("--tools <tools...> --safe-mode --strict-mcp-config --permission-prompts --no-session-persistence");
  else if (${JSON.stringify(name)} === "opencode" && args[0] === "run") console.log("--pure --format --prompt");
  else if (${JSON.stringify(name)} === "opencode") console.log("--pure");
  else console.log("--mode <mode> ask --output-format <format> -p, --print --sandbox <mode>");
  process.exit(0);
}
if (process.env.HARNESS_CWD_FILE) fs.writeFileSync(process.env.HARNESS_CWD_FILE, process.cwd());
if (process.env.HARNESS_ENV_FILE) fs.writeFileSync(process.env.HARNESS_ENV_FILE, JSON.stringify(process.env));
if (process.env.HARNESS_DESCENDANT_PID_FILE && args.includes("--print")) {
  const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { detached: false, stdio: "ignore" });
  fs.writeFileSync(process.env.HARNESS_DESCENDANT_PID_FILE, String(descendant.pid));
}
if (process.env.HARNESS_ARGS_FILE) {
  const configPath = process.env.OPENCODE_CONFIG;
  const config = configPath && fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : undefined;
  fs.writeFileSync(process.env.HARNESS_ARGS_FILE, JSON.stringify({ args, config }));
}
if (process.env.HARNESS_AUTH_ERROR) { console.log(JSON.stringify({ type: "result", is_error: true, result: "Authentication required: subscription login missing" })); process.exit(1); }
if (process.env.HARNESS_TEST_WAIT) { setInterval(() => {}, 1000); }
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  const cli = ${JSON.stringify(name)};
  const promptIndex = args.indexOf("--prompt");
  const prompt = cli === "claude" || cli === "codex" ? stdin : (promptIndex >= 0 ? args[promptIndex + 1] : args.at(-1));
  const answer = String(prompt || "") + "|cwd:" + process.cwd() + "|key:" + (process.env.OPENAI_API_KEY ? "present" : "absent");
  if (cli === "codex") console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: answer } }));
  else if (cli === "opencode") console.log(JSON.stringify({ type: "text", part: { type: "text", text: answer } }));
  else console.log(JSON.stringify({ type: "result", result: answer }));
  if (process.env.HARNESS_EXIT_AFTER_OUTPUT) process.exit(0);
});
`;
  const path = join(fakeBin, name);
  await writeFile(path, script, { encoding: "utf8", mode: 0o700 });
  await chmod(path, 0o700);
}
