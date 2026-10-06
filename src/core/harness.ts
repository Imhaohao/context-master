import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export type AgentCli = "claude" | "codex" | "opencode" | "cursor";

export interface CliStatus {
  id: AgentCli;
  name: string;
  installed: boolean;
  ready: boolean;
  path?: string;
  version?: string;
  detail?: string;
}

export interface SpecialistEvent {
  type: "status" | "output";
  text: string;
}

export interface SpecialistInput {
  cli: AgentCli;
  prompt: string;
  signal?: AbortSignal;
  onEvent?: (event: SpecialistEvent) => void;
}

export interface SpecialistResult {
  text: string;
  cli: AgentCli;
  durationMs: number;
}

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_PROBE_OUTPUT_BYTES = 128 * 1024;
const SPECIALIST_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 5_000;
const PROCESS_GROUP_KILL_DELAY_MS = 250;

interface ResolvedExecutable {
  path: string;
  candidate: string;
}

interface ProbeResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

interface CapabilityCheckSuccess {
  ok: true;
  disabledFeatures: string[];
}

type CapabilityCheck = CapabilityCheckSuccess | { ok: false; detail: string };

interface CodexFeature {
  name: string;
  status: string;
}

interface CliAdapter {
  id: AgentCli;
  name: string;
  candidates: string[];
  capabilityCommands: string[][];
  subscriptionCommand: string[];
  requiredCapabilities: RegExp[];
  safetySummary: string;
  runSupported: boolean;
  unsupportedDetail?: string;
}

interface ProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  stdin?: string;
  signal?: AbortSignal;
}

interface ProcessFailure {
  reason: Error;
  termination?: ProcessTermination;
}

interface ProcessTermination {
  complete: Promise<void>;
}

const CODEX_SAFETY_FEATURES = [
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
];

const SANITIZED_ENVIRONMENT_KEYS = [
  "HOME",
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERMINFO",
  "TERMINFO_DIRS",
  "USER",
  "LOGNAME",
  "SHELL",
  "CI",
  "NO_COLOR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "SystemRoot",
  "ComSpec",
  "WINDIR",
];

const SUPERVISOR_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const { rmSync } = require("node:fs");

const killDelayMs = 250;
let child;
let payload;
let disconnecting = false;
let disconnectTimer;

process.stdout.on("error", () => undefined);
process.stderr.on("error", () => undefined);

function killChild() {
  if (!child?.pid) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // The child may have exited between disconnect and cleanup.
  }
}

function removeWorkingDirectory() {
  if (!payload || typeof payload.cwd !== "string") return;
  try {
    rmSync(payload.cwd, { force: true, recursive: true });
  } catch {
    // The owning process normally removes the directory; best effort here
    // covers the owning process being terminated before its finally block.
  }
}

function killProcessGroup() {
  try {
    if (process.platform !== "win32") {
      process.kill(-process.pid, "SIGKILL");
    } else {
      process.kill(process.pid, "SIGKILL");
    }
  } catch {
    // The group may already be gone.
  }
}

function handleDisconnect() {
  if (disconnecting) return;
  disconnecting = true;
  killChild();
  disconnectTimer = setTimeout(() => {
    removeWorkingDirectory();
    killProcessGroup();
  }, killDelayMs);
}

process.on("disconnect", handleDisconnect);
process.on("message", (message) => {
  if (payload || !message || typeof message !== "object" || typeof message.command !== "string" || !Array.isArray(message.args) || typeof message.cwd !== "string" || !message.env || typeof message.env !== "object") {
    process.stderr.write("Invalid specialist supervisor request\n");
    process.exitCode = 1;
    process.exit();
    return;
  }
  payload = message;
  child = spawn(payload.command, payload.args, {
    cwd: payload.cwd,
    detached: false,
    env: payload.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.once("error", (error) => {
    process.stderr.write(String(error && error.message ? error.message : error) + "\n");
  });
  child.once("close", (code) => {
    if (disconnecting) return;
    if (disconnectTimer) clearTimeout(disconnectTimer);
    process.exitCode = typeof code === "number" ? code : 1;
    process.exit();
  });
  if (typeof payload.stdin === "string") child.stdin.end(payload.stdin);
  else child.stdin.end();
});
`;

const ADAPTERS: Record<AgentCli, CliAdapter> = {
  claude: {
    id: "claude",
    name: "Claude Code",
    candidates: ["claude"],
    capabilityCommands: [["--help"]],
    subscriptionCommand: ["auth", "status", "--json"],
    requiredCapabilities: [
      /--tools[\s<]/u,
      /--safe-mode/u,
      /--strict-mcp-config/u,
      /--permission-prompts/u,
      /--no-session-persistence/u,
    ],
    safetySummary: "tools disabled, safe mode, strict MCP config, and no session persistence",
    runSupported: true,
  },
  codex: {
    id: "codex",
    name: "Codex CLI",
    candidates: ["codex"],
    capabilityCommands: [["exec", "--help"], ["features", "list"]],
    subscriptionCommand: ["login", "status"],
    requiredCapabilities: [
      /--disable\s+<FEATURE>/u,
      /--sandbox\s+<SANDBOX_MODE>/u,
      /--strict-config/u,
      /--ignore-user-config/u,
      /--ignore-rules/u,
      /--ephemeral/u,
    ],
    safetySummary: "all advertised tools disabled, web search disabled, read-only sandbox, ignored user config/rules, and ephemeral session",
    runSupported: true,
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    candidates: ["opencode"],
    capabilityCommands: [["--pure", "--help"], ["run", "--pure", "--help"]],
    subscriptionCommand: ["auth", "list", "--pure"],
    requiredCapabilities: [
      /--pure/u,
      /--format/u,
      /--prompt/u,
    ],
    safetySummary: "pure mode and deny-all tool permissions in an isolated config",
    runSupported: true,
  },
  cursor: {
    id: "cursor",
    name: "Cursor Agent",
    candidates: ["agent", "cursor-agent", "cursor"],
    capabilityCommands: [["--help"]],
    subscriptionCommand: ["status", "--format", "json"],
    requiredCapabilities: [
      /--mode\s+<mode>/u,
      /\bask\b/u,
      /--output-format\s+<format>/u,
      /-p,\s+--print/u,
      /--sandbox\s+<mode>/u,
    ],
    safetySummary: "ask mode and enabled sandbox in an isolated workspace",
    runSupported: false,
    unsupportedDetail: "Cursor ask mode still exposes read/search tools and has no CLI deny-all switch",
  },
};

const ADAPTER_ORDER: AgentCli[] = ["claude", "codex", "opencode", "cursor"];

/**
 * Run a specialist in a fresh temporary directory with tool access disabled.
 * The prompt is data supplied to a new CLI process; no source transcript is
 * resumed or made available as a working directory.
 */
export async function runSpecialist(input: SpecialistInput): Promise<SpecialistResult> {
  validateInput(input);
  const startedAt = Date.now();
  const adapter = ADAPTERS[input.cli];
  const executable = await requireExecutable(adapter);
  const [capabilityCheck, subscriptionCheck] = await Promise.all([
    inspectCapabilities(adapter, executable),
    inspectSubscription(adapter, executable),
  ]);
  if (!capabilityCheck.ok) {
    throw new Error(`Cannot safely run ${adapter.name}: ${capabilityCheck.detail}`);
  }
  if (!adapter.runSupported) {
    throw new Error(`Cannot safely run ${adapter.name}: ${adapter.unsupportedDetail ?? "no-tool execution is unavailable"}`);
  }
  if (!subscriptionCheck.ok) {
    throw new Error(`Cannot safely run ${adapter.name}: subscription auth is not verified (${subscriptionCheck.detail})`);
  }

  const workingDirectory = await mkdtemp(join(tmpdir(), "context-master-specialist-"));
  try {
    const invocation = await createInvocation(adapter, executable, workingDirectory, input.prompt, capabilityCheck);
    emit(input.onEvent, { type: "status", text: `Starting ${adapter.name}` });
    const processResult = await runProcess(executable.path, invocation.args, {
      cwd: workingDirectory,
      env: invocation.env,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      signal: input.signal,
      stdin: invocation.stdin,
      timeoutMs: SPECIALIST_TIMEOUT_MS,
    });
    if (processResult.code !== 0) {
      throw new Error(formatProcessFailure(adapter, processResult));
    }
    const text = extractAssistantText(processResult.stdout);
    if (text === "") {
      throw new Error(`${adapter.name} returned no assistant text`);
    }
    emit(input.onEvent, { type: "output", text });
    emit(input.onEvent, { type: "status", text: `${adapter.name} finished` });
    return { cli: input.cli, durationMs: Date.now() - startedAt, text };
  } finally {
    await rm(workingDirectory, { force: true, recursive: true });
  }
}

/**
 * Discover installed CLIs and report whether the invocation safety contract is
 * available in the installed version. Version and help probes never receive a
 * user prompt and use sanitized environment variables.
 */
export async function getCliStatuses(): Promise<CliStatus[]> {
  return Promise.all(ADAPTER_ORDER.map((id) => getCliStatus(ADAPTERS[id])));
}

async function getCliStatus(adapter: CliAdapter): Promise<CliStatus> {
  const executable = await findExecutable(adapter.candidates);
  if (!executable) {
    return { detail: "Executable not found on PATH", id: adapter.id, installed: false, name: adapter.name, ready: false };
  }

  const versionProbe = await probeProcess(executable, ["--version"], PROBE_TIMEOUT_MS);
  const version = firstOutputLine(versionProbe.stdout) ?? firstOutputLine(versionProbe.stderr);
  const [capabilityCheck, subscriptionCheck] = await Promise.all([
    inspectCapabilities(adapter, executable),
    inspectSubscription(adapter, executable),
  ]);
  const status: CliStatus = {
    id: adapter.id,
    installed: true,
    name: adapter.name,
    path: executable.path,
    ready: adapter.runSupported && capabilityCheck.ok && subscriptionCheck.ok,
  };
  if (version) status.version = version;
  status.detail = formatStatusDetail(adapter, capabilityCheck, subscriptionCheck);
  return status;
}

function formatStatusDetail(
  adapter: CliAdapter,
  capabilityCheck: CapabilityCheck,
  subscriptionCheck: { ok: true } | { ok: false; detail: string },
): string {
  const details: string[] = [];
  if (!adapter.runSupported) details.push(`Unsupported for no-tool specialists: ${adapter.unsupportedDetail ?? adapter.safetySummary}`);
  else if (capabilityCheck.ok) details.push(`Safety ready: ${adapter.safetySummary}`);
  else details.push(`Safety guard unavailable: ${capabilityCheck.detail}`);
  if (subscriptionCheck.ok) details.push("subscription auth verified");
  else details.push(`subscription auth unverified: ${subscriptionCheck.detail}`);
  return details.join("; ");
}

async function requireExecutable(adapter: CliAdapter): Promise<ResolvedExecutable> {
  const executable = await findExecutable(adapter.candidates);
  if (executable) return executable;
  throw new Error(`${adapter.name} is not installed or is not on PATH`);
}

async function findExecutable(candidates: string[]): Promise<ResolvedExecutable | undefined> {
  const pathEntries = cliSearchPathEntries();
  for (const candidate of candidates) {
    const directCandidate = candidate.includes("/") ? candidate : undefined;
    const possiblePaths = directCandidate ? [candidate] : pathEntries.map((entry) => join(entry, candidate));
    for (const possiblePath of possiblePaths) {
      if (await isExecutable(possiblePath)) return { candidate, path: possiblePath };
    }
  }
  return undefined;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function inspectCapabilities(
  adapter: CliAdapter,
  executable: ResolvedExecutable,
): Promise<CapabilityCheck> {
  const probes = await Promise.all(
    adapter.capabilityCommands.map((args) => probeProcess(executable, prefixArguments(executable, args), PROBE_TIMEOUT_MS)),
  );
  const helpText = probes.map((probe) => `${probe.stdout}\n${probe.stderr}`).join("\n");
  const missing = adapter.requiredCapabilities.filter((capability) => !capability.test(helpText));
  if (missing.length > 0) {
    return { detail: `installed CLI does not advertise ${missing.map((item) => item.source).join(", ")}`, ok: false };
  }
  if (adapter.id !== "codex") return { disabledFeatures: [], ok: true };
  const featureProbe = probes.at(-1);
  if (!featureProbe || featureProbe.code !== 0) {
    return { detail: "Codex feature inventory command failed", ok: false };
  }
  const featureInventory = parseCodexFeatureInventory(`${featureProbe.stdout}\n${featureProbe.stderr}`);
  if (!featureInventory.ok) return featureInventory;
  return { disabledFeatures: featureInventory.disabledFeatures, ok: true };
}

function parseCodexFeatureInventory(output: string): CapabilityCheckSuccess | { ok: false; detail: string } {
  const lines = stripAnsi(output).split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "");
  const features: CodexFeature[] = [];
  for (const line of lines) {
    if (isCodexFeatureHeader(line)) continue;
    const fields = line.split(/\s+/u);
    const name = fields.shift();
    const lastField = fields.at(-1)?.toLowerCase();
    if (lastField === "true" || lastField === "false") fields.pop();
    const status = fields.join(" ").trim();
    if (!name || !/^[a-z][a-z0-9_-]*$/u.test(name) || !isCodexFeatureStatus(status)) {
      return { detail: "Codex feature inventory is malformed", ok: false };
    }
    features.push({ name, status });
  }
  if (features.length === 0) return { detail: "Codex feature inventory is empty", ok: false };
  const names = new Set(features.map((feature) => feature.name));
  if (names.size !== features.length) return { detail: "Codex feature inventory contains duplicate entries", ok: false };
  const missing = CODEX_SAFETY_FEATURES.filter((name) => !names.has(name));
  if (missing.length > 0) {
    return { detail: `Codex feature inventory is incomplete (missing ${missing.join(", ")})`, ok: false };
  }
  const disabledFeatures = [...new Set(features.filter((feature) => feature.status.toLowerCase() !== "removed").map((feature) => feature.name))].sort();
  return { disabledFeatures, ok: true };
}

function isCodexFeatureStatus(status: string): boolean {
  return /^(?:alpha|beta|deprecated|disabled|enabled|experimental|preview|removed|stable|under development)$/iu.test(status);
}

function isCodexFeatureHeader(line: string): boolean {
  return /^feature\s+status(?:\s+(?:default|enabled))?$/iu.test(line);
}

async function inspectSubscription(
  adapter: CliAdapter,
  executable: ResolvedExecutable,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const probe = await probeProcess(
    executable,
    prefixArguments(executable, adapter.subscriptionCommand),
    PROBE_TIMEOUT_MS,
    adapter.id === "codex",
  );
  return verifySubscription(adapter.id, `${probe.stdout}\n${probe.stderr}`, probe.code);
}

function verifySubscription(
  cli: AgentCli,
  output: string,
  code: number | null,
): { ok: true } | { ok: false; detail: string } {
  if (code !== 0) return { detail: "authentication status command failed", ok: false };
  if (cli === "claude") return verifyClaudeSubscription(output);
  if (cli === "codex") return verifyCodexSubscription(output);
  if (cli === "cursor") return verifyCursorSubscription(output);
  return verifyOpenCodeSubscription(output);
}

function verifyClaudeSubscription(output: string): { ok: true } | { ok: false; detail: string } {
  try {
    const status = JSON.parse(output) as Record<string, unknown>;
    if (status.loggedIn === true && status.authMethod === "claude.ai" && status.apiProvider === "firstParty" && typeof status.subscriptionType === "string") {
      return { ok: true };
    }
  } catch {
    // Treat malformed or mixed auth output as unverified.
  }
  return { detail: "Claude Code is not reporting a claude.ai first-party subscription", ok: false };
}

function verifyCodexSubscription(output: string): { ok: true } | { ok: false; detail: string } {
  const normalized = output.toLowerCase();
  if (/logged in using chatgpt/u.test(normalized)) return { ok: true };
  if (/api[ -]?key|api token|not logged in/u.test(normalized)) {
    return { detail: "Codex is not logged in through ChatGPT", ok: false };
  }
  return { detail: "Codex login status does not identify ChatGPT subscription auth", ok: false };
}

function verifyOpenCodeSubscription(output: string): { ok: true } | { ok: false; detail: string } {
  const normalized = output.toLowerCase();
  if (/\b(subscription|oauth|chatgpt|claude\.ai)\b/u.test(normalized) && !/\bapi\b/u.test(normalized)) {
    return { ok: true };
  }
  return { detail: "OpenCode credentials do not identify a subscription or OAuth provider", ok: false };
}

function verifyCursorSubscription(output: string): { ok: true } | { ok: false; detail: string } {
  try {
    const status = JSON.parse(output) as Record<string, unknown>;
    const authMethod = typeof status.authMethod === "string" ? status.authMethod.toLowerCase() : "";
    const subscriptionType = typeof status.subscriptionType === "string" ? status.subscriptionType.toLowerCase() : "";
    if (status.isAuthenticated === true && /subscription|oauth|cursor/u.test(`${authMethod} ${subscriptionType}`)) {
      return { ok: true };
    }
  } catch {
    // Treat malformed or mixed auth output as unverified.
  }
  return { detail: "Cursor authentication does not identify a subscription mode", ok: false };
}

function prefixArguments(executable: ResolvedExecutable, args: string[]): string[] {
  return executable.candidate === "cursor" ? ["agent", ...args] : args;
}

async function probeProcess(
  executable: ResolvedExecutable,
  args: string[],
  timeoutMs: number,
  preserveCodexHome = false,
): Promise<ProbeResult> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "context-master-probe-"));
  try {
    return await runProcess(executable.path, args, {
      cwd: temporaryDirectory,
      env: sanitizedEnvironment({ preserveCodexHome }),
      maxOutputBytes: MAX_PROBE_OUTPUT_BYTES,
      timeoutMs,
    });
  } catch (error) {
    return { code: null, stderr: error instanceof Error ? error.message : "probe failed", stdout: "" };
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

interface Invocation {
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin?: string;
}

async function createInvocation(
  adapter: CliAdapter,
  executable: ResolvedExecutable,
  workingDirectory: string,
  prompt: string,
  capabilityCheck: CapabilityCheckSuccess,
): Promise<Invocation> {
  const env = sanitizedEnvironment({ preserveCodexHome: adapter.id === "codex" });
  if (adapter.id === "claude") return createClaudeInvocation(env, prompt);
  if (adapter.id === "codex") return createCodexInvocation(env, prompt, workingDirectory, capabilityCheck.disabledFeatures);
  if (adapter.id === "opencode") return createOpenCodeInvocation(env, workingDirectory, prompt);
  return createCursorInvocation(env, executable, workingDirectory, prompt);
}

function createClaudeInvocation(env: NodeJS.ProcessEnv, prompt: string): Invocation {
  return {
    args: [
      "--print",
      "--output-format",
      "json",
      "--input-format",
      "text",
      "--tools",
      "",
      "--safe-mode",
      "--strict-mcp-config",
      "--permission-prompts",
      "none",
      "--no-session-persistence",
      "--disable-slash-commands",
    ],
    env,
    stdin: prompt,
  };
}

function createCodexInvocation(
  env: NodeJS.ProcessEnv,
  prompt: string,
  workingDirectory: string,
  disabledFeatures: string[],
): Invocation {
  const disableArguments = disabledFeatures.flatMap((feature) => ["--disable", feature]);
  return {
    args: [
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--strict-config",
      "-c",
      'approval_policy="never"',
      "-c",
      'web_search="disabled"',
      "-c",
      "tools.experimental_request_user_input.enabled=false",
      "-c",
      "tools.update_plan.enabled=false",
      "--sandbox",
      "read-only",
      ...disableArguments,
      "--cd",
      workingDirectory,
      "-",
    ],
    env,
    stdin: prompt,
  };
}

async function createOpenCodeInvocation(
  env: NodeJS.ProcessEnv,
  workingDirectory: string,
  prompt: string,
): Promise<Invocation> {
  const configDirectory = join(workingDirectory, "config");
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  const configPath = join(workingDirectory, "opencode-safe.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        mcp: {},
        permission: { "*": "deny" },
        tools: {
          bash: false,
          edit: false,
          glob: false,
          grep: false,
          lsp: false,
          patch: false,
          question: false,
          read: false,
          skill: false,
          task: false,
          webfetch: false,
          websearch: false,
          write: false,
        },
      },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  );
  const isolatedEnvironment = { ...env, OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_DIR: configDirectory };
  return {
    args: ["run", "--pure", "--format", "json", "--prompt", prompt],
    env: isolatedEnvironment,
    stdin: undefined,
  };
}

function createCursorInvocation(
  env: NodeJS.ProcessEnv,
  executable: ResolvedExecutable,
  workingDirectory: string,
  prompt: string,
): Invocation {
  const commandPrefix = executable.candidate === "cursor" ? ["agent"] : [];
  return {
    args: [
      ...commandPrefix,
      "-p",
      "--mode",
      "ask",
      "--output-format",
      "json",
      "--sandbox",
      "enabled",
      "--workspace",
      workingDirectory,
      prompt,
    ],
    env,
  };
}

function sanitizedEnvironment(options: { preserveCodexHome?: boolean } = {}): NodeJS.ProcessEnv {
  const environment = {} as NodeJS.ProcessEnv;
  for (const key of SANITIZED_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.PATH = cliSearchPathEntries().join(delimiter);
  if (options.preserveCodexHome && process.env.CODEX_HOME !== undefined) {
    environment.CODEX_HOME = process.env.CODEX_HOME;
  }
  if (isHarnessTestEnvironment()) {
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("HARNESS_") && value !== undefined) environment[key] = value;
    }
  }
  return environment;
}

function supervisorEnvironment(): NodeJS.ProcessEnv {
  const environment = { PATH: cliSearchPathEntries().join(delimiter) } as unknown as NodeJS.ProcessEnv;
  if (isElectronNodeRuntime()) environment.ELECTRON_RUN_AS_NODE = "1";
  return environment;
}

function isElectronNodeRuntime(): boolean {
  return process.versions.electron !== undefined || process.env.ELECTRON_RUN_AS_NODE === "1";
}

function isHarnessTestEnvironment(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true" || process.argv.some((argument) => /vitest/u.test(argument));
}

function cliSearchPathEntries(): string[] {
  const inherited = (process.env.PATH ?? "").split(delimiter).filter((entry) => entry !== "");
  const home = homedir();
  const standard = [
    join(home, ".local", "bin"),
    join(home, ".opencode", "bin"),
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  return [...new Set([...inherited, ...standard])];
}

function validateInput(input: SpecialistInput): void {
  if (!ADAPTERS[input.cli]) throw new Error(`Unsupported specialist CLI: ${String(input.cli)}`);
  if (typeof input.prompt !== "string" || input.prompt.trim() === "") {
    throw new Error("Specialist prompt must not be empty");
  }
}

function emit(callback: SpecialistInput["onEvent"], event: SpecialistEvent): void {
  try {
    callback?.(event);
  } catch {
    // Telemetry/UI callbacks must not change the specialist result.
  }
}

async function runProcess(command: string, args: string[], options: ProcessOptions): Promise<ProbeResult> {
  if (options.signal?.aborted) throw abortError();
  return new Promise<ProbeResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, ["-e", SUPERVISOR_SOURCE], {
        cwd: process.cwd(),
        detached: process.platform !== "win32",
        env: supervisorEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let failure: ProcessFailure | undefined;
    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", abortHandler);
    };
    const settle = (error?: Error, result?: ProbeResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error("Process ended without a result"));
    };
    const stop = (reason: Error): void => {
      if (settled || failure) return;
      failure = { reason, termination: terminateProcess(child) };
    };
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > options.maxOutputBytes) {
        stop(new Error("Specialist output exceeded the 1 MB limit"));
        return;
      }
      const text = chunk.toString("utf8");
      if (target === "stdout") stdout += text;
      else stderr += text;
    };
    const abortHandler = (): void => stop(abortError());
    const timeoutTimer = setTimeout(() => stop(new Error("Specialist timed out after 180 seconds")), options.timeoutMs);
    timeoutTimer.unref();
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => stop(error));
    child.once("close", (code) => {
      const termination = failure?.termination ?? terminateProcess(child);
      void settleAfterTermination(termination, failure?.reason, { code, stderr, stdout }, settle);
    });
    if (options.signal) options.signal.addEventListener("abort", abortHandler, { once: true });
    const supervisorRequest = { command, args, cwd: options.cwd, env: options.env, stdin: options.stdin };
    try {
      child.send?.(supervisorRequest, (error) => {
        if (error) stop(error);
      });
    } catch (error) {
      stop(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function settleAfterTermination(
  termination: ProcessTermination | undefined,
  error: Error | undefined,
  result: ProbeResult,
  settle: (error?: Error, result?: ProbeResult) => void,
): Promise<void> {
  await termination?.complete;
  settle(error, result);
}

function terminateProcess(child: ChildProcess): ProcessTermination | undefined {
  if (!sendSignal(child, "SIGTERM")) return undefined;
  let completeTermination: () => void = () => undefined;
  const complete = new Promise<void>((resolve) => {
    completeTermination = resolve;
  });
  setTimeout(() => {
    sendSignal(child, "SIGKILL");
    completeTermination();
  }, PROCESS_GROUP_KILL_DELAY_MS);
  return { complete };
}

function sendSignal(child: ChildProcess, signal: NodeJS.Signals): boolean {
  try {
    if (child.pid && process.platform !== "win32") {
      process.kill(-child.pid, signal);
      return true;
    }
    return child.kill(signal);
  } catch {
    // The process may have exited between the close and kill calls.
    return false;
  }
}

function abortError(): Error {
  const error = new Error("Specialist run cancelled");
  error.name = "AbortError";
  return error;
}

function firstOutputLine(output: string): string | undefined {
  const line = stripAnsi(output).split(/\r?\n/u).map((item) => item.trim()).find((item) => item !== "");
  return line;
}

function extractAssistantText(output: string): string {
  const records = parseRecords(output);
  const segments = records.flatMap((record) => segmentForRecord(record));
  const completeSegments = segments.filter((segment) => segment.rank >= 3);
  const resultSegments = segments.filter((segment) => segment.rank >= 4);
  if (resultSegments.length > 0) return normalizeText(resultSegments.at(-1)?.text ?? "");
  if (completeSegments.length > 0) return mergeSegments(completeSegments);
  if (segments.length > 0) return mergeSegments(segments);
  return records.length === 0 ? normalizeText(stripAnsi(output)) : "";
}

function formatProcessFailure(adapter: CliAdapter, processResult: ProbeResult): string {
  const structuredDetail = extractErrorDetail(processResult.stdout);
  const stderrDetail = firstOutputLine(processResult.stderr);
  const detail = structuredDetail ?? stderrDetail;
  return detail ? `${adapter.name} failed: ${safeDiagnostic(detail)}` : `${adapter.name} exited before producing an answer`;
}

function extractErrorDetail(output: string): string | undefined {
  const records = parseRecords(output);
  for (const record of [...records].reverse()) {
    if (!isRecord(record)) continue;
    if (record.type === "result" && record.is_error === true && typeof record.result === "string") return record.result;
    if (record.type === "error" && typeof record.message === "string") return record.message;
    if (isRecord(record.error) && typeof record.error.message === "string") return record.error.message;
  }
  return undefined;
}

function safeDiagnostic(value: string): string {
  return value
    .replace(/\b(?:sk|sess|tok)-[A-Za-z0-9_-]+\b/gu, "[redacted-token]")
    .replace(/\b(?:api[_ -]?key|token|secret)\s*[:=]\s*\S+/giu, "credential=[redacted]")
    .slice(0, 300);
}

interface TextSegment {
  rank: number;
  text: string;
}

function parseRecords(output: string): unknown[] {
  const cleanOutput = stripAnsi(output).trim();
  if (cleanOutput === "") return [];
  try {
    return [JSON.parse(cleanOutput) as unknown];
  } catch {
    return cleanOutput.split(/\r?\n/u).flatMap((line) => parseJsonLine(line));
  }
}

function parseJsonLine(line: string): unknown[] {
  try {
    return [JSON.parse(line) as unknown];
  } catch {
    return [];
  }
}

function segmentForRecord(value: unknown): TextSegment[] {
  if (!isRecord(value)) return [];
  const type = typeof value.type === "string" ? value.type : "";
  if (type === "result" && typeof value.result === "string") return [{ rank: 4, text: value.result }];
  if (type === "item.completed" && isAgentMessage(value.item)) return [{ rank: 3, text: agentMessageText(value.item) }];
  if (type === "assistant") return assistantMessageSegments(value.message);
  if (type === "message" && value.role === "assistant") return [{ rank: 3, text: contentText(value.content) }];
  if (type === "text") return [{ rank: 1, text: textPart(value.part) }];
  if (value.role === "assistant") return [{ rank: 3, text: contentText(value.content ?? value.text) }];
  if (isAgentMessage(value.item)) return [{ rank: 3, text: agentMessageText(value.item) }];
  if (typeof value.result === "string") return [{ rank: 4, text: value.result }];
  return [];
}

function assistantMessageSegments(value: unknown): TextSegment[] {
  if (!isRecord(value)) return [];
  if (value.role !== undefined && value.role !== "assistant") return [];
  const text = contentText(value.content ?? value.text);
  return text === "" ? [] : [{ rank: 2, text }];
}

function isAgentMessage(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (value.type === "agent_message" || value.type === "assistant_message");
}

function agentMessageText(value: Record<string, unknown>): string {
  return contentText(value.text ?? value.content);
}

function textPart(value: unknown): string {
  if (!isRecord(value)) return "";
  return typeof value.text === "string" ? value.text : "";
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter(isRecord)
    .filter((item) => item.type === "text" || item.type === "output_text")
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .filter((item) => item !== "")
    .join("\n");
}

function mergeSegments(segments: TextSegment[]): string {
  let merged = "";
  for (const segment of segments) {
    const text = normalizeText(segment.text);
    if (text === "" || merged === text || merged.endsWith(text)) continue;
    if (text.startsWith(merged) && merged !== "") {
      merged = text;
      continue;
    }
    merged = appendWithOverlap(merged, text);
  }
  return merged;
}

function appendWithOverlap(existing: string, addition: string): string {
  const maxOverlap = Math.min(existing.length, addition.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (existing.endsWith(addition.slice(0, overlap))) return existing + addition.slice(overlap);
  }
  return existing === "" ? addition : `${existing}\n${addition}`;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
