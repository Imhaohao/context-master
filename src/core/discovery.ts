import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import {
  basename as pathBasename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export type DiscoverableSource = "codex" | "claude" | "opencode" | "cursor";

export interface DiscoveredSession {
  id: string;
  source: DiscoverableSource;
  title: string;
  project?: string;
  updatedAt: string;
  bytes: number;
}

export interface DiscoverySourceStatus {
  source: DiscoveredSession["source"];
  path: string;
  available: boolean;
  detail: string;
}

export interface DiscoveryResult {
  sessions: DiscoveredSession[];
  sources: DiscoverySourceStatus[];
  truncated: boolean;
}

export interface DiscoverOptions {
  home?: string;
  limit?: number;
  query?: string;
  source?: DiscoverableSource;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_DEPTH = 16;
const DEFAULT_LIMIT = 200;

type SqlValue = string | number | bigint | Uint8Array | null;
type SqlRow = Record<string, SqlValue>;

interface ScanState {
  filesSeen: number;
  truncated: boolean;
}

interface CatalogEntry extends DiscoveredSession {
  path: string;
  root: string;
  kind: "file" | "opencode" | "cursor";
  key?: string;
  cursorScope?: "global" | "workspace";
}

interface DirectoryInspection {
  path: string;
  available: boolean;
  detail: string;
}

interface FileInfo {
  bytes: number;
  updatedAt: string;
}

interface OpenCodeSessionExport {
  title: string;
  project?: string;
  externalId: string;
  messages: ExportMessage[];
}

interface CursorHeader {
  composerId: string;
  title: string;
  project?: string;
  createdAt?: number;
  updatedAt?: number;
}

interface CursorSessionExport {
  composerId: string;
  title: string;
  project?: string;
  messages: ExportMessage[];
}

interface ExportMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : undefined;
  }
  return undefined;
}

function rowString(row: SqlRow, key: string): string | undefined {
  return stringValue(row[key]);
}

function rowNumber(row: SqlRow, key: string): number | undefined {
  return numberValue(row[key]);
}

function sqlText(value: SqlValue | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return undefined;
}

function jsonRecord(value: SqlValue | undefined): Record<string, unknown> | undefined {
  const text = sqlText(value);
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function timestampFromMilliseconds(value: number | undefined, fallback: Date): string {
  if (value === undefined) return fallback.toISOString();
  const milliseconds = value < 100_000_000_000 ? value * 1000 : value;
  const timestamp = new Date(milliseconds);
  return Number.isNaN(timestamp.getTime()) ? fallback.toISOString() : timestamp.toISOString();
}

function timestampFromFile(info: { mtimeMs: number }): string {
  return timestampFromMilliseconds(info.mtimeMs, new Date(0));
}

function opaqueId(...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\u0000"), "utf8").digest("base64url");
  return `session_${digest}`;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(/*turbopackIgnore: true*/ path);
  }
}

function pathIsWithin(candidate: string, root: string): boolean {
  const child = canonicalPath(candidate);
  const parent = canonicalPath(root);
  const distance = relative(parent, child);
  return distance === "" || (!distance.startsWith(`..${sep}`) && distance !== ".." && !isAbsolute(distance));
}

function inspectDirectory(path: string): DirectoryInspection {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      return { path, available: false, detail: "Skipped because the source directory is a symbolic link." };
    }
    if (!stat.isDirectory()) {
      return { path, available: false, detail: "Source path exists but is not a directory." };
    }
    const canonical = realpathSync.native(path);
    return { path: canonical, available: true, detail: "Directory is available." };
  } catch {
    return { path, available: false, detail: "Directory was not found or could not be read." };
  }
}

function inspectFile(path: string): FileInfo | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return { bytes: stat.size, updatedAt: timestampFromFile(stat) };
  } catch {
    return undefined;
  }
}

function canInspectFile(path: string, root: string): boolean {
  if (!pathIsWithin(path, root)) return false;
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function markFile(state: ScanState): boolean {
  if (state.filesSeen >= MAX_FILES) {
    state.truncated = true;
    return false;
  }
  state.filesSeen += 1;
  return true;
}

function walkFiles(
  root: string,
  state: ScanState,
  predicate: (path: string) => boolean,
): string[] {
  const files: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      state.truncated = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      state.truncated = true;
      return;
    }
    for (const entry of entries) {
      const candidate = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(candidate, depth + 1);
        continue;
      }
      if (!entry.isFile() || !markFile(state)) {
        if (state.truncated) return;
        continue;
      }
      if (predicate(candidate)) files.push(candidate);
    }
  };
  walk(root, 0);
  return files;
}

function fileTitle(path: string): string {
  const extension = extname(path);
  const stem = pathBasename(path, extension);
  return stem || "Imported session";
}

function projectFromPath(root: string, path: string, source: DiscoverableSource): string | undefined {
  if (source !== "claude") return undefined;
  const parts = relative(root, dirname(path)).split(sep).filter(Boolean);
  return parts[0];
}

function makeFileEntry(
  source: DiscoverableSource,
  file: string,
  root: string,
  home: string,
): CatalogEntry | undefined {
  const info = inspectFile(file);
  if (!info || !canInspectFile(file, root)) return undefined;
  return {
    id: opaqueId(source, relative(home, file)),
    source,
    title: fileTitle(file),
    ...(projectFromPath(root, file, source) ? { project: projectFromPath(root, file, source) } : {}),
    updatedAt: info.updatedAt,
    bytes: info.bytes,
    path: file,
    root,
    kind: "file",
  };
}

function scanTextSource(
  source: DiscoverableSource,
  rootPaths: string[],
  home: string,
  state: ScanState,
  predicate: (path: string) => boolean,
): { entries: CatalogEntry[]; status: DiscoverySourceStatus } {
  const entries: CatalogEntry[] = [];
  const inspections = rootPaths.map(inspectDirectory);
  for (const inspection of inspections) {
    if (!inspection.available) continue;
    for (const file of walkFiles(inspection.path, state, predicate)) {
      const entry = makeFileEntry(source, file, inspection.path, home);
      if (entry) entries.push(entry);
    }
  }
  const available = inspections.some((inspection) => inspection.available);
  const details = inspections.filter((inspection) => inspection.available).length > 0
    ? `Scanned regular files under ${rootPaths.join(" and ")}.`
    : inspections.map((inspection) => inspection.detail).join(" ");
  return {
    entries,
    status: {
      source,
      path: rootPaths.join(", "),
      available,
      detail: details,
    },
  };
}

function conciseTitle(value: string | undefined, fallback: string): string {
  const title = value?.replace(/\s+/gu, " ").trim();
  return title ? title.slice(0, 120) : fallback;
}

function codexStateDatabase(path: string): boolean {
  return /^state_[^/]+\.sqlite$/u.test(pathBasename(path));
}

function codexStatePaths(home: string): string[] {
  const root = sourceRoot(home, ".codex");
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && codexStateDatabase(entry.name))
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

function codexThreadRows(database: DatabaseSync): SqlRow[] {
  try {
    return sqlRows(database.prepare(`
      SELECT id, rollout_path, cwd, title, name, first_user_message, updated_at, updated_at_ms
      FROM threads
      ORDER BY updated_at DESC, id ASC
      LIMIT ?
    `), MAX_FILES);
  } catch {
    return [];
  }
}

function codexThreadTitle(row: SqlRow, fallback: string): string {
  return conciseTitle(rowString(row, "title") ?? rowString(row, "name") ?? rowString(row, "first_user_message"), fallback);
}

function applyCodexThreadRow(row: SqlRow, entries: Map<string, CatalogEntry>): boolean {
  const rolloutPath = rowString(row, "rollout_path");
  if (!rolloutPath) return false;
  const entry = entries.get(canonicalPath(rolloutPath));
  if (!entry) return false;
  entry.title = codexThreadTitle(row, entry.title);
  const project = rowString(row, "cwd");
  if (project) entry.project = project;
  const updatedAt = rowNumber(row, "updated_at_ms") ?? rowNumber(row, "updated_at");
  if (updatedAt !== undefined) entry.updatedAt = timestampFromMilliseconds(updatedAt, new Date(entry.updatedAt));
  return true;
}

function applyCodexMetadata(entries: CatalogEntry[], home: string, state: ScanState): boolean {
  const byPath = new Map(entries.map((entry) => [canonicalPath(entry.path), entry]));
  const root = sourceRoot(home, ".codex");
  let matched = false;
  const paths = codexStatePaths(home);
  for (const databasePath of paths) {
    const info = inspectFile(databasePath);
    if (!info || !canInspectFile(databasePath, root) || !markFile(state)) continue;
    let database: DatabaseSync | undefined;
    try {
      database = openReadOnly(databasePath);
      const rows = codexThreadRows(database);
      for (const row of rows) matched ||= applyCodexThreadRow(row, byPath);
    } catch {
      continue;
    } finally {
      database?.close();
    }
  }
  return matched;
}

function scanCodex(home: string, state: ScanState): { entries: CatalogEntry[]; status: DiscoverySourceStatus } {
  const result = scanTextSource(
    "codex",
    [sourceRoot(home, ".codex", "sessions"), sourceRoot(home, ".codex", "archived_sessions")],
    home,
    state,
    isJsonl,
  );
  const metadata = applyCodexMetadata(result.entries, home, state);
  return {
    entries: result.entries,
    status: metadata
      ? { ...result.status, detail: `${result.status.detail} Read-only Codex thread metadata supplied titles and project paths.` }
      : result.status,
  };
}

function claudeIndexRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of ["entries", "sessions", "items"]) {
    const nested = value[key];
    if (Array.isArray(nested)) return nested.filter(isRecord);
    if (isRecord(nested)) return Object.values(nested).filter(isRecord);
  }
  return Object.values(value).filter(isRecord);
}

function claudeIndexPaths(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(root, entry.name, "sessions-index.json"));
  } catch {
    return [];
  }
}

function metadataTimestamp(value: unknown): string | undefined {
  const number = numberValue(value);
  if (number !== undefined) return timestampFromMilliseconds(number, new Date(0));
  const text = stringValue(value);
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function claudeIndexPath(record: Record<string, unknown>, indexPath: string): string | undefined {
  const value = stringValue(record.fullPath) ?? stringValue(record.path) ?? stringValue(record.sessionFile);
  if (!value) return undefined;
  return resolve(/*turbopackIgnore: true*/ isAbsolute(value) ? value : join(/*turbopackIgnore: true*/ dirname(indexPath), value));
}

function applyClaudeIndexRecord(record: Record<string, unknown>, indexPath: string, entries: Map<string, CatalogEntry>, root: string): boolean {
  const path = claudeIndexPath(record, indexPath);
  if (!path || !pathIsWithin(path, root)) return false;
  const entry = entries.get(canonicalPath(path));
  if (!entry) return false;
  entry.title = conciseTitle(stringValue(record.summary) ?? stringValue(record.name) ?? stringValue(record.title) ?? stringValue(record.firstPrompt), entry.title);
  const project = stringValue(record.projectPath) ?? stringValue(record.cwd) ?? stringValue(record.project);
  if (project) entry.project = project;
  const updatedAt = metadataTimestamp(record.modified ?? record.updatedAt ?? record.lastUpdatedAt ?? record.fileMtime ?? record.mtime);
  if (updatedAt) entry.updatedAt = updatedAt;
  return true;
}

function applyClaudeIndexes(entries: CatalogEntry[], root: string, state: ScanState): boolean {
  const byPath = new Map(entries.map((entry) => [canonicalPath(entry.path), entry]));
  let matched = false;
  for (const indexPath of claudeIndexPaths(root)) {
    const info = inspectFile(indexPath);
    if (!info || !canInspectFile(indexPath, root) || !markFile(state)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readBoundedFile(indexPath, root));
    } catch {
      continue;
    }
    for (const record of claudeIndexRecords(parsed)) matched ||= applyClaudeIndexRecord(record, indexPath, byPath, root);
  }
  return matched;
}

function scanClaude(home: string, state: ScanState): { entries: CatalogEntry[]; status: DiscoverySourceStatus } {
  const root = sourceRoot(home, ".claude", "projects");
  const result = scanTextSource("claude", [root], home, state, isJsonl);
  const inspection = inspectDirectory(root);
  const metadata = inspection.available && applyClaudeIndexes(result.entries, inspection.path, state);
  return {
    entries: result.entries,
    status: metadata
      ? { ...result.status, detail: `${result.status.detail} Read-only Claude session index metadata supplied titles and project paths.` }
      : result.status,
  };
}

function isJsonl(path: string): boolean {
  return extname(path).toLowerCase() === ".jsonl";
}

function sourceRoot(home: string, ...parts: string[]): string {
  return join(home, ...parts);
}

function openReadOnly(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

function sqlRows(statement: ReturnType<DatabaseSync["prepare"]>, ...parameters: (string | number)[]): SqlRow[] {
  return statement.all(...parameters) as unknown as SqlRow[];
}

function openCodeSessionRows(database: DatabaseSync): SqlRow[] {
  const statement = database.prepare(`
    SELECT s.id, s.title, s.directory, s.time_updated, s.time_created,
           p.name AS project_name, p.worktree AS project_worktree
    FROM session AS s
    LEFT JOIN project AS p ON p.id = s.project_id
    ORDER BY s.time_updated DESC, s.id ASC
  `);
  return sqlRows(statement);
}

function openCodeEntry(
  row: SqlRow,
  databasePath: string,
  databaseRoot: string,
  home: string,
  databaseInfo: FileInfo,
): CatalogEntry | undefined {
  const id = rowString(row, "id");
  if (!id) return undefined;
  const title = rowString(row, "title") ?? id;
  const project = rowString(row, "directory") ?? rowString(row, "project_name") ?? rowString(row, "project_worktree");
  const updatedAt = timestampFromMilliseconds(rowNumber(row, "time_updated"), new Date(databaseInfo.updatedAt));
  return {
    id: opaqueId("opencode", relative(home, databasePath), id),
    source: "opencode",
    title,
    ...(project ? { project } : {}),
    updatedAt,
    bytes: databaseInfo.bytes,
    path: databasePath,
    root: databaseRoot,
    kind: "opencode",
    key: id,
  };
}

function scanOpenCode(
  home: string,
  state: ScanState,
): { entries: CatalogEntry[]; status: DiscoverySourceStatus } {
  const root = sourceRoot(home, ".local", "share", "opencode");
  const inspection = inspectDirectory(root);
  const databasePath = sourceRoot(root, "opencode.db");
  const databaseInfo = inspectFile(databasePath);
  if (!inspection.available) {
    return {
      entries: [],
      status: { source: "opencode", path: root, available: false, detail: inspection.detail },
    };
  }
  if (!databaseInfo || !canInspectFile(databasePath, inspection.path)) {
    return {
      entries: [],
      status: {
        source: "opencode",
        path: root,
        available: true,
        detail: "OpenCode data directory is available, but opencode.db was not found; no sessions were imported.",
      },
    };
  }
  if (!markFile(state)) {
    return {
      entries: [],
      status: { source: "opencode", path: root, available: true, detail: "File scan cap reached before OpenCode database inspection." },
    };
  }
  let database: DatabaseSync | undefined;
  try {
    database = openReadOnly(databasePath);
    const entries = openCodeSessionRows(database)
      .map((row) => openCodeEntry(row, databasePath, inspection.path, home, databaseInfo))
      .filter((entry): entry is CatalogEntry => Boolean(entry));
    return {
      entries,
      status: {
        source: "opencode",
        path: root,
        available: true,
        detail: "OpenCode session metadata is available; selected sessions load from SQLite in read-only mode.",
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown SQLite error";
    return {
      entries: [],
      status: { source: "opencode", path: root, available: true, detail: `OpenCode database could not be read: ${detail}` },
    };
  } finally {
    database?.close();
  }
}

const CURSOR_GLOBAL_HEADERS_KEY = "composer.composerHeaders";
const CURSOR_WORKSPACE_DATA_KEY = "composer.composerData";
const CURSOR_COMPOSER_DATA_PREFIX = "composerData:";
const CURSOR_BUBBLE_PREFIX = "bubbleId:";

type CursorKvTable = "ItemTable" | "cursorDiskKV";

function cursorTableRows(
  database: DatabaseSync,
  table: CursorKvTable | "composerHeaders",
  key?: string,
): SqlRow[] {
  try {
    if (key === undefined) return sqlRows(database.prepare(`SELECT * FROM ${table}`));
    return sqlRows(database.prepare(`SELECT key, value FROM ${table} WHERE key = ?`), key);
  } catch {
    return [];
  }
}

function cursorHeaderRows(database: DatabaseSync, scope: "global" | "workspace"): SqlRow[] {
  if (scope === "workspace") return cursorTableRows(database, "ItemTable", CURSOR_WORKSPACE_DATA_KEY);
  const tableRows = cursorTableRows(database, "composerHeaders");
  if (tableRows.length > 0) return tableRows;
  return cursorTableRows(database, "ItemTable", CURSOR_GLOBAL_HEADERS_KEY);
}

function cursorHeaderRecords(row: SqlRow): Record<string, unknown>[] {
  const parsed = jsonRecord(row.value);
  if (parsed && Array.isArray(parsed.allComposers)) {
    return parsed.allComposers.filter(isRecord);
  }
  return parsed ? [parsed] : [row];
}

function cursorProject(record: Record<string, unknown>): string | undefined {
  for (const key of ["project", "cwd", "directory", "workspace", "workspaceIdentifier", "agentProjectId"]) {
    const direct = stringValue(record[key]);
    if (direct) return direct;
    const nested = record[key];
    if (isRecord(nested)) {
      for (const nestedKey of ["path", "uri", "folder", "configPath", "id"]) {
        const value = stringValue(nested[nestedKey]);
        if (value) return value;
      }
    }
  }
  return undefined;
}

function cursorHeader(record: Record<string, unknown>, fallback: SqlRow): CursorHeader | undefined {
  const composerId = stringValue(record.composerId) ?? rowString(fallback, "composerId");
  if (!composerId) return undefined;
  const title = cursorHeaderTitle(record, fallback, composerId);
  const project = cursorHeaderProject(record, fallback);
  const createdAt = numberValue(record.createdAt) ?? rowNumber(fallback, "createdAt");
  const updatedAt = cursorHeaderUpdatedAt(record, fallback);
  return { composerId, title, ...(project ? { project } : {}), ...(createdAt === undefined ? {} : { createdAt }), ...(updatedAt === undefined ? {} : { updatedAt }) };
}

function cursorHeaderTitle(record: Record<string, unknown>, fallback: SqlRow, composerId: string): string {
  return stringValue(record.name) ?? stringValue(record.title) ?? rowString(fallback, "name") ?? composerId;
}

function cursorHeaderProject(record: Record<string, unknown>, fallback: SqlRow): string | undefined {
  return cursorProject(record) ?? rowString(fallback, "workspaceId") ?? rowString(fallback, "workspaceIdentifier");
}

function cursorHeaderUpdatedAt(record: Record<string, unknown>, fallback: SqlRow): number | undefined {
  return numberValue(record.lastUpdatedAt) ?? numberValue(record.updatedAt) ?? numberValue(record.recency) ??
    rowNumber(fallback, "lastUpdatedAt") ?? rowNumber(fallback, "recency");
}

function cursorHeaders(database: DatabaseSync, scope: "global" | "workspace"): CursorHeader[] {
  const byId = new Map<string, CursorHeader>();
  for (const row of cursorHeaderRows(database, scope)) {
    for (const record of cursorHeaderRecords(row)) {
      const header = cursorHeader(record, row);
      if (header) byId.set(header.composerId, header);
    }
  }
  return [...byId.values()];
}

function cursorNativeEntries(
  databasePath: string,
  root: string,
  home: string,
  scope: "global" | "workspace",
  info: FileInfo,
): { entries: CatalogEntry[]; readable: boolean } {
  let database: DatabaseSync | undefined;
  try {
    database = openReadOnly(databasePath);
    const headers = cursorHeaders(database, scope);
    const entries = headers.map((header) => ({
      id: opaqueId("cursor", relative(home, databasePath), header.composerId),
      source: "cursor" as const,
      title: header.title,
      ...(header.project ? { project: header.project } : {}),
      updatedAt: timestampFromMilliseconds(header.updatedAt ?? header.createdAt, new Date(info.updatedAt)),
      bytes: info.bytes,
      path: databasePath,
      root,
      kind: "cursor" as const,
      key: header.composerId,
      cursorScope: scope,
    }));
    return { entries, readable: headers.length > 0 };
  } catch {
    return { entries: [], readable: false };
  } finally {
    database?.close();
  }
}

function cursorManualExport(path: string): boolean {
  const extension = extname(path).toLowerCase();
  if (![".json", ".jsonl", ".md", ".markdown", ".txt"].includes(extension)) return false;
  if (pathBasename(path).toLowerCase() === "meta.json") return false;
  const normalized = path.toLowerCase().replaceAll("\\", "/");
  if (normalized.includes("/anysphere.cursor-retrieval/")) return false;
  return normalized.includes("/.cursor/chats/") || /(chat|conversation|transcript|export|session)/iu.test(pathBasename(path));
}

function cursorStateDatabase(path: string): boolean {
  return pathBasename(path).toLowerCase() === "state.vscdb";
}

function scanCursorNativeFile(
  path: string,
  root: string,
  home: string,
  scope: "global" | "workspace",
  state: ScanState,
): { entries: CatalogEntry[]; found: boolean; readable: boolean } {
  const info = inspectFile(path);
  if (!info || !canInspectFile(path, root)) return { entries: [], found: false, readable: false };
  if (!markFile(state)) return { entries: [], found: true, readable: false };
  const result = cursorNativeEntries(path, root, home, scope, info);
  return { ...result, found: true };
}

interface CursorNativeScan {
  entries: CatalogEntry[];
  found: boolean;
  readable: boolean;
}

function emptyCursorNativeScan(): CursorNativeScan {
  return { entries: [], found: false, readable: false };
}

function scanCursorGlobal(
  inspection: DirectoryInspection,
  home: string,
  state: ScanState,
): CursorNativeScan {
  if (!inspection.available) return emptyCursorNativeScan();
  return scanCursorNativeFile(join(inspection.path, "state.vscdb"), inspection.path, home, "global", state);
}

function scanCursorWorkspace(
  inspection: DirectoryInspection,
  home: string,
  state: ScanState,
): CursorNativeScan & { manualEntries: CatalogEntry[] } {
  if (!inspection.available) return { ...emptyCursorNativeScan(), manualEntries: [] };
  const result: CursorNativeScan & { manualEntries: CatalogEntry[] } = { ...emptyCursorNativeScan(), manualEntries: [] };
  const files = walkFiles(inspection.path, state, (path) => cursorStateDatabase(path) || cursorManualExport(path));
  for (const file of files) {
    if (cursorStateDatabase(file)) {
      const native = scanCursorNativeFile(file, inspection.path, home, "workspace", state);
      result.entries.push(...native.entries);
      result.found ||= native.found;
      result.readable ||= native.readable;
      continue;
    }
    const entry = makeFileEntry("cursor", file, inspection.path, home);
    if (entry) result.manualEntries.push(entry);
  }
  return result;
}

function scanCursorManualChatExports(inspection: DirectoryInspection, home: string, state: ScanState): CatalogEntry[] {
  if (!inspection.available) return [];
  return walkFiles(inspection.path, state, cursorManualExport)
    .map((file) => makeFileEntry("cursor", file, inspection.path, home))
    .filter((entry): entry is CatalogEntry => Boolean(entry));
}

function cursorScanDetail(
  available: boolean,
  nativeFound: boolean,
  nativeReadable: boolean,
  manualCount: number,
): string {
  const exports = `${manualCount} manual JSON, JSONL, Markdown, or text export${manualCount === 1 ? "" : "s"}`;
  if (!available) return "Cursor data directories were not found. Native stores remain unverified; use a manual JSON, JSONL, Markdown, or text export.";
  if (nativeReadable) return `Cursor native state.vscdb metadata is available; selected composers load exact visible bubbles in read-only mode. ${exports} also found.`;
  if (nativeFound) return `Cursor state.vscdb files were found but could not be read. Native metadata remains unavailable and unverified; ${exports} found; use manual export fallback.`;
  return `Cursor native state.vscdb metadata was not found. ${exports} found; native stores remain unverified; use manual export fallback.`;
}

function scanCursor(home: string, state: ScanState): { entries: CatalogEntry[]; status: DiscoverySourceStatus } {
  const chatRoot = sourceRoot(home, ".cursor", "chats");
  const globalRoot = sourceRoot(home, "Library", "Application Support", "Cursor", "User", "globalStorage");
  const workspaceRoot = sourceRoot(home, "Library", "Application Support", "Cursor", "User", "workspaceStorage");
  const roots = [chatRoot, globalRoot, workspaceRoot];
  const inspections = roots.map(inspectDirectory);
  const global = scanCursorGlobal(inspections[1], home, state);
  const workspace = scanCursorWorkspace(inspections[2], home, state);
  const entries = [...global.entries, ...workspace.entries, ...workspace.manualEntries, ...scanCursorManualChatExports(inspections[0], home, state)];
  const available = inspections.some((inspection) => inspection.available);
  const detail = cursorScanDetail(available, global.found || workspace.found, global.readable || workspace.readable, entries.filter((entry) => entry.kind === "file").length);
  return {
    entries,
    status: { source: "cursor", path: roots.join(", "), available, detail },
  };
}

function scanCatalog(home: string): { entries: CatalogEntry[]; sources: DiscoverySourceStatus[]; state: ScanState } {
  const codexState: ScanState = { filesSeen: 0, truncated: false };
  const codex = scanCodex(home, codexState);
  const claudeState: ScanState = { filesSeen: 0, truncated: false };
  const claude = scanClaude(home, claudeState);
  const opencodeState: ScanState = { filesSeen: 0, truncated: false };
  const opencode = scanOpenCode(home, opencodeState);
  const cursorState: ScanState = { filesSeen: 0, truncated: false };
  const cursor = scanCursor(home, cursorState);
  const entries = [...codex.entries, ...claude.entries, ...opencode.entries, ...cursor.entries]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  return {
    entries,
    sources: [
      scanStatus(codex.status, codexState),
      scanStatus(claude.status, claudeState),
      scanStatus(opencode.status, opencodeState),
      scanStatus(cursor.status, cursorState),
    ],
    state: {
      filesSeen: codexState.filesSeen + claudeState.filesSeen + opencodeState.filesSeen + cursorState.filesSeen,
      truncated: codexState.truncated || claudeState.truncated || opencodeState.truncated || cursorState.truncated,
    },
  };
}

function publicEntry(entry: CatalogEntry): DiscoveredSession {
  const { id, source, title, project, updatedAt, bytes } = entry;
  return { id, source, title, ...(project ? { project } : {}), updatedAt, bytes };
}

function catalogMatches(entry: CatalogEntry, options: Pick<DiscoverOptions, "query" | "source">): boolean {
  if (options.source && entry.source !== options.source) return false;
  const query = options.query?.trim().toLocaleLowerCase();
  if (!query) return true;
  return [entry.title, entry.project].filter(Boolean).some((value) => value?.toLocaleLowerCase().includes(query));
}

function filterCatalog(entries: CatalogEntry[], options: Pick<DiscoverOptions, "query" | "source">): CatalogEntry[] {
  return entries.filter((entry) => catalogMatches(entry, options));
}

function sessionLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(0, Math.floor(limit));
}

function scanStatus(status: DiscoverySourceStatus, state: ScanState): DiscoverySourceStatus {
  if (!state.truncated) return status;
  return {
    ...status,
    detail: `${status.detail} The scan was capped; narrow this source directory or use a manual export before retrying.`,
  };
}

function readBoundedFile(path: string, root: string): string {
  if (!canInspectFile(path, root)) throw new Error("Selected session file is no longer a regular file inside its source root");
  const info = inspectFile(path);
  if (!info) throw new Error("Selected session file is unavailable");
  if (info.bytes > MAX_FILE_BYTES) throw new Error("Selected session exceeds the 8 MiB import limit");
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) throw new Error("Selected session exceeds the 8 MiB import limit");
  return text;
}

function cursorComposerRecord(
  database: DatabaseSync,
  scope: "global" | "workspace",
  composerId: string,
): Record<string, unknown> | undefined {
  const keys = scope === "workspace"
    ? [CURSOR_WORKSPACE_DATA_KEY, `${CURSOR_COMPOSER_DATA_PREFIX}${composerId}`]
    : [`${CURSOR_COMPOSER_DATA_PREFIX}${composerId}`];
  const tables: CursorKvTable[] = scope === "workspace" ? ["ItemTable", "cursorDiskKV"] : ["cursorDiskKV", "ItemTable"];
  for (const table of tables) {
    for (const key of keys) {
      const row = cursorTableRows(database, table, key)[0];
      const record = row ? jsonRecord(row.value) : undefined;
      if (!record) continue;
      const composers = Array.isArray(record.allComposers) ? record.allComposers.filter(isRecord) : [];
      const selected = composers.find((candidate) => stringValue(candidate.composerId) === composerId);
      if (selected) return selected;
      if (stringValue(record.composerId) === composerId || key !== CURSOR_WORKSPACE_DATA_KEY) {
        return stringValue(record.composerId) ? record : { ...record, composerId };
      }
    }
  }
  return undefined;
}

function cursorInlineRecords(record: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  const map = record.conversationMap;
  if (isRecord(map)) {
    for (const [key, value] of Object.entries(map)) {
      const nested = isRecord(value) ? value : typeof value === "string" ? jsonRecord(value) : undefined;
      if (nested) result.set(key, nested);
    }
  }
  const conversation = record.conversation;
  if (Array.isArray(conversation)) {
    for (const value of conversation) {
      if (!isRecord(value)) continue;
      const bubbleId = stringValue(value.bubbleId) ?? stringValue(value.id);
      if (bubbleId) result.set(bubbleId, value);
    }
  }
  return result;
}

function cursorBubbleIds(record: Record<string, unknown>, inline: Map<string, Record<string, unknown>>): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (!isRecord(value)) return;
    const bubbleId = stringValue(value.bubbleId) ?? stringValue(value.id);
    if (bubbleId && !seen.has(bubbleId)) {
      seen.add(bubbleId);
      ids.push(bubbleId);
    }
  };
  for (const key of ["fullConversationHeadersOnly", "conversation"]) {
    const values = record[key];
    if (Array.isArray(values)) values.forEach(add);
  }
  for (const key of inline.keys()) {
    if (!seen.has(key)) {
      seen.add(key);
      ids.push(key);
    }
  }
  return ids;
}

function cursorRole(record: Record<string, unknown>): "user" | "assistant" | undefined {
  const value = record.role ?? record.type;
  if (typeof value === "number") return value === 1 ? "user" : value === 2 ? "assistant" : undefined;
  const normalized = stringValue(value)?.toLowerCase();
  if (normalized === "1" || normalized === "human" || normalized === "user") return "user";
  if (normalized === "2" || normalized === "ai" || normalized === "assistant") return "assistant";
  return undefined;
}

function cursorTimestamp(record: Record<string, unknown>): string | undefined {
  const number = numberValue(record.createdAtMs) ?? numberValue(record.createdAt) ?? numberValue(record.timestamp);
  if (number !== undefined) return timestampFromMilliseconds(number, new Date(0));
  const text = stringValue(record.createdAt) ?? stringValue(record.timestamp);
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function cursorMessage(record: Record<string, unknown>): ExportMessage | undefined {
  const role = cursorRole(record);
  const text = stringValue(record.text) ?? stringValue(record.content);
  if (!role || !text) return undefined;
  const timestamp = cursorTimestamp(record);
  return timestamp ? { role, content: text, timestamp } : { role, content: text };
}

function cursorRowsByKeys(database: DatabaseSync, table: CursorKvTable, keys: string[]): Map<string, SqlRow> {
  const rows = new Map<string, SqlRow>();
  const chunkSize = 250;
  for (let start = 0; start < keys.length; start += chunkSize) {
    const chunk = keys.slice(start, start + chunkSize);
    const placeholders = chunk.map(() => "?").join(",");
    try {
      for (const row of sqlRows(database.prepare(`SELECT key, value FROM ${table} WHERE key IN (${placeholders})`), ...chunk)) {
        const key = rowString(row, "key");
        if (key) rows.set(key, row);
      }
    } catch {
      return rows;
    }
  }
  return rows;
}

function cursorMessages(
  database: DatabaseSync,
  scope: "global" | "workspace",
  composerId: string,
  record: Record<string, unknown>,
): ExportMessage[] {
  const inline = cursorInlineRecords(record);
  const bubbleIds = cursorBubbleIds(record, inline);
  const keys = bubbleIds.map((bubbleId) => `${CURSOR_BUBBLE_PREFIX}${composerId}:${bubbleId}`);
  const tables: CursorKvTable[] = scope === "workspace" ? ["ItemTable", "cursorDiskKV"] : ["cursorDiskKV", "ItemTable"];
  const stored = new Map<string, SqlRow>();
  for (const table of tables) {
    for (const [key, row] of cursorRowsByKeys(database, table, keys)) stored.set(key, row);
  }
  const messages: ExportMessage[] = [];
  for (const bubbleId of bubbleIds) {
    const key = `${CURSOR_BUBBLE_PREFIX}${composerId}:${bubbleId}`;
    const storedRecord = jsonRecord(stored.get(key)?.value);
    const message = cursorMessage(storedRecord ?? inline.get(bubbleId) ?? {});
    if (message) messages.push(message);
  }
  return messages;
}

function cursorSessionExport(
  database: DatabaseSync,
  scope: "global" | "workspace",
  composerId: string,
  fallbackTitle: string,
  fallbackProject: string | undefined,
): CursorSessionExport {
  const record = cursorComposerRecord(database, scope, composerId);
  if (!record) throw new Error("Selected Cursor composer no longer exists");
  const title = stringValue(record.name) ?? stringValue(record.title) ?? fallbackTitle;
  const project = cursorProject(record) ?? fallbackProject;
  const messages = cursorMessages(database, scope, composerId, record);
  if (messages.length === 0) throw new Error("Selected Cursor composer has no visible user or assistant messages");
  return { composerId, title, ...(project ? { project } : {}), messages };
}

function partText(record: Record<string, unknown>): string | undefined {
  if (stringValue(record.type) !== "text") return undefined;
  return stringValue(record.text);
}

function openCodeMessageRows(database: DatabaseSync, sessionId: string): SqlRow[] {
  return sqlRows(
    database.prepare(`
      SELECT id, time_created, data
      FROM message
      WHERE session_id = ?
      ORDER BY time_created ASC, id ASC
    `),
    sessionId,
  );
}

function openCodePartRows(database: DatabaseSync, sessionId: string): SqlRow[] {
  return sqlRows(
    database.prepare(`
      SELECT id, message_id, time_created, data
      FROM part
      WHERE session_id = ?
      ORDER BY time_created ASC, id ASC
    `),
    sessionId,
  );
}

function partsByMessage(rows: SqlRow[]): Map<string, string[]> {
  const parts = new Map<string, string[]>();
  for (const row of rows) {
    const messageId = rowString(row, "message_id");
    const record = jsonRecord(row.data);
    const text = record ? partText(record) : undefined;
    if (!messageId || !text) continue;
    const existing = parts.get(messageId) ?? [];
    existing.push(text);
    parts.set(messageId, existing);
  }
  return parts;
}

function exportMessage(
  row: SqlRow,
  partTexts: Map<string, string[]>,
): ExportMessage | undefined {
  const record = jsonRecord(row.data);
  if (!record) return undefined;
  const role = stringValue(record.role);
  if (role !== "user" && role !== "assistant") return undefined;
  const id = rowString(row, "id");
  if (!id) return undefined;
  const text = (partTexts.get(id) ?? []).join("\n").trim();
  if (!text) return undefined;
  const time = rowNumber(row, "time_created");
  const timestamp = time === undefined ? undefined : timestampFromMilliseconds(time, new Date(0));
  return timestamp ? { role, content: text, timestamp } : { role, content: text };
}

function openCodeExportRows(
  database: DatabaseSync,
  sessionId: string,
): ExportMessage[] {
  const parts = partsByMessage(openCodePartRows(database, sessionId));
  return openCodeMessageRows(database, sessionId)
    .map((row) => exportMessage(row, parts))
    .filter((message): message is ExportMessage => Boolean(message));
}

function openCodeSessionExport(database: DatabaseSync, sessionId: string): OpenCodeSessionExport {
  const row = sqlRows(database.prepare(`
    SELECT s.id, s.title, s.directory
    FROM session AS s
    WHERE s.id = ?
  `), sessionId)[0];
  if (!row || rowString(row, "id") !== sessionId) throw new Error("Selected OpenCode session no longer exists");
  const title = rowString(row, "title") ?? sessionId;
  const project = rowString(row, "directory");
  const messages = openCodeExportRows(database, sessionId);
  if (messages.length === 0) throw new Error("Selected OpenCode session has no visible user or assistant messages");
  return { title, ...(project ? { project } : {}), externalId: sessionId, messages };
}

function safeExportName(title: string, source: DiscoverableSource): string {
  const stem = title.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || "session";
  return `${source}-${stem}.json`;
}

function loadOpenCode(entry: CatalogEntry): { name: string; text: string } {
  if (!entry.key) throw new Error("Selected OpenCode session has no stable key");
  const info = inspectFile(entry.path);
  if (!info || !canInspectFile(entry.path, entry.root)) throw new Error("Selected OpenCode database is unavailable");
  let database: DatabaseSync | undefined;
  try {
    database = openReadOnly(entry.path);
    const exported = openCodeSessionExport(database, entry.key);
    const document = {
      source: "opencode",
      sessionID: exported.externalId,
      title: exported.title,
      ...(exported.project ? { project: exported.project } : {}),
      externalId: exported.externalId,
      messages: exported.messages,
    };
    const text = JSON.stringify(document);
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) throw new Error("Selected OpenCode session exceeds the 8 MiB import limit");
    return { name: safeExportName(exported.title, "opencode"), text };
  } finally {
    database?.close();
  }
}

function loadCursor(entry: CatalogEntry): { name: string; text: string } {
  if (!entry.key || !entry.cursorScope) throw new Error("Selected Cursor composer has no stable key");
  const info = inspectFile(entry.path);
  if (!info || !canInspectFile(entry.path, entry.root)) throw new Error("Selected Cursor database is unavailable");
  let database: DatabaseSync | undefined;
  try {
    database = openReadOnly(entry.path);
    const exported = cursorSessionExport(database, entry.cursorScope, entry.key, entry.title, entry.project);
    const document = {
      source: "cursor",
      composerId: exported.composerId,
      title: exported.title,
      ...(exported.project ? { project: exported.project } : {}),
      externalId: exported.composerId,
      messages: exported.messages,
    };
    const text = JSON.stringify(document);
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) throw new Error("Selected Cursor session exceeds the 8 MiB import limit");
    return { name: safeExportName(exported.title, "cursor"), text };
  } finally {
    database?.close();
  }
}

export async function discoverSessions(options: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const home = resolve(/*turbopackIgnore: true*/ options.home ?? homedir());
  const catalog = scanCatalog(home);
  const limit = sessionLimit(options.limit);
  const filtered = filterCatalog(catalog.entries, options);
  const truncated = catalog.state.truncated || filtered.length > limit;
  return {
    sessions: filtered.slice(0, limit).map(publicEntry),
    sources: catalog.sources,
    truncated,
  };
}

export async function loadDiscoveredSession(
  id: string,
  options: Pick<DiscoverOptions, "home"> = {},
): Promise<{ name: string; text: string }> {
  if (!/^session_[A-Za-z0-9_-]{43}$/u.test(id)) throw new Error("Unknown session id");
  const home = resolve(/*turbopackIgnore: true*/ options.home ?? homedir());
  const catalog = scanCatalog(home);
  const entry = catalog.entries.find((candidate) => candidate.id === id);
  if (!entry) throw new Error("Unknown or unavailable session id");
  if (entry.kind === "opencode") return loadOpenCode(entry);
  if (entry.kind === "cursor") return loadCursor(entry);
  return { name: pathBasename(entry.path), text: readBoundedFile(entry.path, entry.root) };
}
