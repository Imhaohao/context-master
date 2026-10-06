import { DatabaseSync } from "node:sqlite";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { discoverSessions, loadDiscoveredSession } from "../src/core/discovery";

const homes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "context-master-discovery-"));
  homes.push(home);
  return home;
}

function writeSession(home: string, path: string, text: string): string {
  const target = join(home, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, text, "utf8");
  return target;
}

function createOpenCodeDatabase(home: string): string {
  const path = writeSession(home, ".local/share/opencode/opencode.db", "");
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL,
      name TEXT,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      directory TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  database.prepare("INSERT INTO project VALUES (?, ?, ?, ?)").run("project-1", "/tmp/project", "Demo project", 1791316900000);
  database.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)").run(
    "ses_demo",
    "project-1",
    "OpenCode demo",
    "/tmp/project",
    1791316900000,
    1791316920000,
  );
  database.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
    "msg-user",
    "ses_demo",
    1791316921000,
    JSON.stringify({ role: "user" }),
  );
  database.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
    "msg-assistant",
    "ses_demo",
    1791316922000,
    JSON.stringify({ role: "assistant" }),
  );
  database.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run(
    "part-user",
    "msg-user",
    "ses_demo",
    1791316921000,
    JSON.stringify({ type: "text", text: "What should I preserve?" }),
  );
  database.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run(
    "part-assistant",
    "msg-assistant",
    "ses_demo",
    1791316922000,
    JSON.stringify({ type: "text", text: "The visible conversation and its provenance." }),
  );
  database.close();
  return path;
}

function createCursorGlobalDatabase(home: string): string {
  const path = writeSession(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb", "");
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY,
      workspaceId TEXT,
      createdAt INTEGER,
      lastUpdatedAt INTEGER,
      isArchived INTEGER,
      value TEXT
    );
    CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
    CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);
  `);
  database.prepare("INSERT INTO composerHeaders VALUES (?, ?, ?, ?, ?, ?)").run(
    "composer-global",
    "/tmp/cursor-project",
    1791316800000,
    1791316860000,
    0,
    JSON.stringify({ composerId: "composer-global", name: "Global Cursor session", workspaceIdentifier: "/tmp/cursor-project", createdAt: 1791316800000, lastUpdatedAt: 1791316860000 }),
  );
  database.prepare("INSERT INTO composerHeaders VALUES (?, ?, ?, ?, ?, ?)").run(
    "composer-other",
    "/tmp/other-project",
    1791316800000,
    1791316801000,
    0,
    JSON.stringify({ composerId: "composer-other", name: "Other Cursor session" }),
  );
  database.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(
    "composerData:composer-global",
    JSON.stringify({
      composerId: "composer-global",
      name: "Global Cursor session",
      fullConversationHeadersOnly: [
        { bubbleId: "bubble-user", type: 1 },
        { bubbleId: "bubble-tool", type: 2 },
        { bubbleId: "bubble-thinking", type: 2 },
        { bubbleId: "bubble-assistant", type: 2 },
      ],
    }),
  );
  const insertBubble = database.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)");
  insertBubble.run("bubbleId:composer-global:bubble-user", JSON.stringify({ bubbleId: "bubble-user", type: 1, text: "Keep this user turn.", createdAt: 1791316861000 }));
  insertBubble.run("bubbleId:composer-global:bubble-tool", JSON.stringify({ bubbleId: "bubble-tool", type: 2, toolFormerData: { tool: "terminal" } }));
  insertBubble.run("bubbleId:composer-global:bubble-thinking", JSON.stringify({ bubbleId: "bubble-thinking", type: 2, thinking: { text: "Private reasoning" } }));
  insertBubble.run("bubbleId:composer-global:bubble-assistant", JSON.stringify({ bubbleId: "bubble-assistant", type: 2, text: "Keep this assistant turn.", createdAt: 1791316862000 }));
  insertBubble.run("bubbleId:composer-other:other-user", JSON.stringify({ bubbleId: "other-user", type: 1, text: "Wrong composer." }));
  database.close();
  return path;
}

function createCursorWorkspaceDatabase(home: string): string {
  const path = writeSession(home, "Library/Application Support/Cursor/User/workspaceStorage/workspace-a/state.vscdb", "");
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);");
  database.prepare("INSERT INTO ItemTable VALUES (?, ?)").run(
    "composer.composerData",
    JSON.stringify({
      allComposers: [{
        composerId: "composer-workspace",
        name: "Workspace Cursor session",
        workspaceIdentifier: "/tmp/workspace-project",
        fullConversationHeadersOnly: [{ bubbleId: "workspace-user", type: 1 }, { bubbleId: "workspace-assistant", type: 2 }],
      }],
    }),
  );
  database.prepare("INSERT INTO ItemTable VALUES (?, ?)").run(
    "bubbleId:composer-workspace:workspace-user",
    JSON.stringify({ bubbleId: "workspace-user", type: 1, text: "Workspace question" }),
  );
  database.prepare("INSERT INTO ItemTable VALUES (?, ?)").run(
    "bubbleId:composer-workspace:workspace-assistant",
    JSON.stringify({ bubbleId: "workspace-assistant", type: 2, text: "Workspace answer" }),
  );
  database.close();
  return path;
}

function createCodexMetadataDatabase(home: string, rolloutPath: string): string {
  const path = writeSession(home, ".codex/state_1.sqlite", "");
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, name TEXT, first_user_message TEXT, updated_at INTEGER, updated_at_ms INTEGER);");
  database.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "codex-demo",
    rolloutPath,
    "/tmp/codex-project",
    "A useful Codex title",
    null,
    "ignored fallback",
    1791316860,
    null,
  );
  database.close();
  return path;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("discoverSessions", () => {
  it("catalogs Codex, Claude, and OpenCode metadata without reading transcript bodies", async () => {
    const home = makeHome();
    const codexText = '{"type":"session_meta","payload":{"id":"codex-1"}}\n';
    writeSession(home, ".codex/sessions/2026/10/06/rollout-demo.jsonl", codexText);
    writeSession(home, ".claude/projects/demo/project-session.jsonl", '{"type":"user","message":{"role":"user","content":"hello"}}\n');
    const databasePath = createOpenCodeDatabase(home);
    writeSession(home, ".cursor/chats/example/meta.json", JSON.stringify({ schemaVersion: 1, hasConversation: true }));
    writeSession(home, ".cursor/chats/example/store.db", "placeholder");

    const result = await discoverSessions({ home });

    expect(result.sessions.map(({ source }) => source)).toEqual(expect.arrayContaining(["codex", "claude", "opencode"]));
    expect(result.sessions.every(({ bytes }) => bytes > 0)).toBe(true);
    expect(result.sources).toHaveLength(4);
    expect(result.sources.find(({ source }) => source === "opencode")?.available).toBe(true);
    expect(result.sources.find(({ source }) => source === "cursor")?.detail).toMatch(/unverified/i);
    expect(result.sources.find(({ source }) => source === "cursor")?.detail).toMatch(/manual export/i);
    expect(lstatSync(databasePath).isFile()).toBe(true);
  });

  it("loads a selected OpenCode session by id and exports a parser-compatible document", async () => {
    const home = makeHome();
    createOpenCodeDatabase(home);

    const catalog = await discoverSessions({ home });
    const session = catalog.sessions.find(({ source }) => source === "opencode");
    expect(session).toBeDefined();
    const loaded = await loadDiscoveredSession(session?.id ?? "", { home });
    const document = JSON.parse(loaded.text) as {
      source: string;
      externalId: string;
      messages: Array<{ role: string; content: string }>;
    };

    expect(loaded.name).toContain("opencode-");
    expect(document.source).toBe("opencode");
    expect(document.externalId).toBe("ses_demo");
    expect(document.messages).toEqual([
      { role: "user", content: "What should I preserve?", timestamp: "2026-10-06T20:02:01.000Z" },
      { role: "assistant", content: "The visible conversation and its provenance.", timestamp: "2026-10-06T20:02:02.000Z" },
    ]);
  });

  it("loads regular files only and rejects caller-supplied paths", async () => {
    const home = makeHome();
    const transcript = '{"type":"session_meta","payload":{"id":"codex-1"}}\n';
    const file = writeSession(home, ".codex/sessions/demo.jsonl", transcript);
    const outside = writeSession(home, "outside.jsonl", "outside");
    const link = join(home, ".codex/sessions/link.jsonl");
    symlinkSync(outside, link);

    const catalog = await discoverSessions({ home });
    const codex = catalog.sessions.find(({ source }) => source === "codex");
    expect(catalog.sessions).toHaveLength(1);
    expect(codex).toBeDefined();
    const loaded = await loadDiscoveredSession(codex?.id ?? "", { home });
    expect(loaded.text).toBe(transcript);
    expect(file).toContain(".codex");
    await expect(loadDiscoveredSession(file, { home })).rejects.toThrow(/Unknown session id/);
  });

  it("reports truncation when the requested result limit omits sessions", async () => {
    const home = makeHome();
    writeSession(home, ".codex/sessions/a.jsonl", "a");
    writeSession(home, ".codex/sessions/b.jsonl", "b");

    const result = await discoverSessions({ home, limit: 1 });

    expect(result.sessions).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.sources.some(({ detail }) => /capped/i.test(detail))).toBe(false);
  });

  it("filters by source and query before applying the result limit", async () => {
    const home = makeHome();
    writeSession(home, ".codex/sessions/keep-this.jsonl", "keep");
    writeSession(home, ".codex/sessions/other.jsonl", "other");
    writeSession(home, ".claude/projects/demo/claude.jsonl", "claude");

    const result = await discoverSessions({ home, source: "codex", query: "keep", limit: 1 });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.source).toBe("codex");
    expect(result.sessions[0]?.title).toBe("keep-this");
    expect(result.truncated).toBe(false);
  });

  it("offers manual Cursor exports while honestly marking native stores unverified", async () => {
    const home = makeHome();
    writeSession(home, ".cursor/chats/export.json", JSON.stringify({ source: "cursor", messages: [] }));
    writeSession(home, "Library/Application Support/Cursor/User/workspaceStorage/demo/state.vscdb", "sqlite placeholder");

    const result = await discoverSessions({ home });
    const cursor = result.sessions.find(({ source }) => source === "cursor");
    const source = result.sources.find(({ source: sourceName }) => sourceName === "cursor");

    expect(cursor?.title).toBe("export");
    expect(source?.available).toBe(true);
    expect(source?.detail).toMatch(/manual JSON/);
    expect(source?.detail).toMatch(/unverified/);
  });

  it("discovers and loads exact Cursor global composers while excluding tool and thinking bubbles", async () => {
    const home = makeHome();
    createCursorGlobalDatabase(home);

    const result = await discoverSessions({ home });
    const cursorSessions = result.sessions.filter(({ source }) => source === "cursor");
    expect(cursorSessions.map(({ title }) => title)).toEqual(expect.arrayContaining(["Global Cursor session", "Other Cursor session"]));
    expect(result.sources.find(({ source }) => source === "cursor")?.detail).toMatch(/metadata is available/i);

    const selected = cursorSessions.find(({ title }) => title === "Global Cursor session");
    const loaded = await loadDiscoveredSession(selected?.id ?? "", { home });
    const document = JSON.parse(loaded.text) as { source: string; composerId: string; messages: Array<{ role: string; content: string }> };

    expect(document.source).toBe("cursor");
    expect(document.composerId).toBe("composer-global");
    expect(document.messages).toEqual([
      { role: "user", content: "Keep this user turn.", timestamp: "2026-10-06T20:01:01.000Z" },
      { role: "assistant", content: "Keep this assistant turn.", timestamp: "2026-10-06T20:01:02.000Z" },
    ]);
    expect(loaded.text).not.toContain("Wrong composer");
    expect(loaded.text).not.toContain("Private reasoning");
  });

  it("discovers and loads a selected Cursor workspace composer from ItemTable", async () => {
    const home = makeHome();
    createCursorWorkspaceDatabase(home);

    const result = await discoverSessions({ home });
    const selected = result.sessions.find(({ title }) => title === "Workspace Cursor session");
    expect(selected).toBeDefined();
    const loaded = await loadDiscoveredSession(selected?.id ?? "", { home });
    const document = JSON.parse(loaded.text) as { externalId: string; messages: Array<{ role: string; content: string }> };

    expect(document.externalId).toBe("composer-workspace");
    expect(document.messages).toEqual([
      { role: "user", content: "Workspace question" },
      { role: "assistant", content: "Workspace answer" },
    ]);
  });

  it("uses bounded Codex and Claude metadata indexes for useful titles", async () => {
    const home = makeHome();
    const codexPath = writeSession(home, ".codex/sessions/metadata.jsonl", "session body");
    createCodexMetadataDatabase(home, codexPath);
    writeSession(home, ".claude/projects/demo/metadata.jsonl", "session body");
    writeSession(home, ".claude/projects/demo/sessions-index.json", JSON.stringify({
      entries: [{
        fullPath: join(home, ".claude/projects/demo/metadata.jsonl"),
        summary: "Claude indexed summary",
        projectPath: "/tmp/claude-project",
        modified: 1791316862000,
      }],
    }));

    const result = await discoverSessions({ home });
    const codex = result.sessions.find(({ source }) => source === "codex");
    const claude = result.sessions.find(({ source }) => source === "claude");

    expect(codex?.title).toBe("A useful Codex title");
    expect(codex?.project).toBe("/tmp/codex-project");
    expect(claude?.title).toBe("Claude indexed summary");
    expect(claude?.project).toBe("/tmp/claude-project");
  });
});
