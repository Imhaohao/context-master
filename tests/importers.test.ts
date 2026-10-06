import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseSession } from "../src/core/importers";

const fixture = (name: string): string =>
  readFileSync(resolve(__dirname, "fixtures", name), "utf8");

describe("parseSession", () => {
  it("normalizes Codex response and event records without duplicating turns", () => {
    const [session] = parseSession(fixture("codex-session.jsonl"), "codex-session.jsonl");

    expect(session.source).toBe("codex");
    expect(session.externalId).toBe("codex-demo-1");
    expect(session.project).toBe("/tmp/example-project");
    expect(session.messages).toEqual([
      { role: "user", text: "How should I structure this parser?", timestamp: "2026-10-06T20:00:01.000Z" },
      { role: "assistant", text: "Keep format detection separate from normalization.", timestamp: "2026-10-06T20:00:02.000Z" },
    ]);
    expect(JSON.stringify(session)).not.toContain("secret");
  });

  it("keeps Claude text parts while excluding thinking and tools", () => {
    const [session] = parseSession(fixture("claude-session.jsonl"), "claude-session.jsonl");

    expect(session.source).toBe("claude");
    expect(session.externalId).toBe("claude-demo-1");
    expect(session.messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Explain the import boundary." },
      { role: "assistant", text: "Import only visible conversation text." },
      { role: "user", text: "Can it handle Markdown?" },
    ]);
    expect(JSON.stringify(session)).not.toContain("Private chain");
    expect(JSON.stringify(session)).not.toContain("tool output");
  });

  it("follows only the selected ChatGPT mapping branch", () => {
    const [session] = parseSession(fixture("chatgpt-conversation.json"), "conversations.json");

    expect(session.source).toBe("chatgpt");
    expect(session.title).toBe("Branch-safe import");
    expect(session.externalId).toBe("chatgpt-demo-1");
    expect(session.messages.map(({ text }) => text)).toEqual([
      "Use the selected branch.",
      "Selected branch is imported.",
    ]);
  });

  it("parses a Markdown transcript into visible speaker turns", () => {
    const [session] = parseSession(fixture("generic-transcript.txt"), "notes.txt");

    expect(session.source).toBe("generic");
    expect(session.messages).toEqual([
      { role: "user", text: "Summarize the release checklist." },
      { role: "assistant", text: "Verify parsing, storage, and retrieval before publishing." },
    ]);
  });

  it("parses generic JSON messages and filters unsupported roles", () => {
    const [session] = parseSession(
      JSON.stringify({
        title: "Generic export",
        messages: [
          { role: "system", content: "hidden" },
          { role: "user", content: "Keep the contract small." },
          { role: "assistant", content: [{ type: "text", text: "Then keep the parser strict." }] },
          { role: "tool", content: "ignored" },
        ],
      }),
      "generic.json",
    );

    expect(session.source).toBe("generic");
    expect(session.title).toBe("Generic export");
    expect(session.messages.map(({ text }) => text)).toEqual([
      "Keep the contract small.",
      "Then keep the parser strict.",
    ]);
  });

  it("preserves an explicit normalized source label and external id", () => {
    for (const source of ["codex", "claude", "opencode", "cursor"] as const) {
      const [session] = parseSession(
        JSON.stringify({
          source,
          title: `${source} normalized export`,
          externalId: `${source}-id`,
          messages: [{ role: "user", content: "A visible turn." }],
        }),
        `${source}-export.json`,
      );

      expect(session.source).toBe(source);
      expect(session.externalId).toBe(`${source}-id`);
      expect(session.messages).toEqual([{ role: "user", text: "A visible turn." }]);
    }
  });

  it("recognizes OpenCode storage records and ignores non-text parts", () => {
    const [session] = parseSession(fixture("opencode-session.jsonl"), "opencode-session.jsonl");

    expect(session.source).toBe("opencode");
    expect(session.externalId).toBe("ses_opencode_demo");
    expect(session.project).toBe("/tmp/example-project");
    expect(session.messages.map(({ text }) => text)).toEqual([
      "What belongs in a specialist library?",
      "A focused context and the actions it can perform.",
    ]);
  });

  it("recognizes Cursor conversation exports while excluding tool turns", () => {
    const [session] = parseSession(fixture("cursor-conversation.json"), "cursor-conversation.json");

    expect(session.source).toBe("cursor");
    expect(session.externalId).toBe("cursor-demo-1");
    expect(session.messages.map(({ text }) => text)).toEqual([
      "Find the invariant.",
      "Keep hidden tool activity out of the library.",
    ]);
  });

  it("rejects oversized input before parsing it", () => {
    expect(() => parseSession("x".repeat(8 * 1024 * 1024 + 1), "large.txt")).toThrow(/8 MiB/);
  });

  it("reports unsupported transcripts with no visible turns", () => {
    expect(() => parseSession(JSON.stringify({ messages: [{ role: "tool", content: "ignored" }] }), "empty.json"))
      .toThrow(/No visible user or assistant messages/);
  });
});
