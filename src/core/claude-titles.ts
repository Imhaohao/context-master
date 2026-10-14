import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const SLICE_BYTES = 128 * 1024;

export interface ClaudeSessionHeader {
  title?: string;
  project?: string;
}

interface HeaderState {
  customTitle?: string;
  aiTitle?: string;
  summary?: string;
  firstPrompt?: string;
  project?: string;
}

function readSlice(descriptor: number, start: number, length: number): string {
  const buffer = Buffer.alloc(length);
  const read = readSync(descriptor, buffer, 0, length, start);
  return buffer.subarray(0, read).toString("utf8");
}

// Titles are appended as a session runs, so read the start for the first prompt
// and the end for the latest title instead of the whole transcript.
function readEnds(path: string): string {
  const descriptor = openSync(path, "r");
  try {
    const { size } = fstatSync(descriptor);
    if (size <= SLICE_BYTES * 2) return readSlice(descriptor, 0, size);
    return `${readSlice(descriptor, 0, SLICE_BYTES)}\n${readSlice(descriptor, size - SLICE_BYTES, SLICE_BYTES)}`;
  } finally {
    closeSync(descriptor);
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/gu, " ").trim() : undefined;
}

function promptText(content: unknown): string | undefined {
  if (typeof content === "string") return text(content);
  if (!Array.isArray(content)) return undefined;
  const part = content.find((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text");
  return text((part as { text?: unknown } | undefined)?.text);
}

function withoutInjectedBlocks(prompt: string): string {
  return prompt.replace(/<([a-z][a-z-]*)>[\s\S]*?<\/\1>/gu, " ").trim();
}

function isTypedPrompt(prompt: string): boolean {
  return Boolean(prompt) && !prompt.startsWith("<") && !prompt.startsWith("Caveat:") && !prompt.startsWith("[Request interrupted");
}

function userPrompt(record: Record<string, unknown>): string | undefined {
  if (record.type !== "user" || record.isMeta === true || record.isSidechain === true) return undefined;
  const message = record.message as { content?: unknown } | undefined;
  const prompt = text(withoutInjectedBlocks(promptText(message?.content) ?? ""));
  return prompt && isTypedPrompt(prompt) ? prompt : undefined;
}

function absorb(state: HeaderState, record: Record<string, unknown>): void {
  if (record.type === "custom-title") state.customTitle = text(record.customTitle) ?? state.customTitle;
  if (record.type === "ai-title") state.aiTitle ??= text(record.aiTitle);
  if (record.type === "summary") state.summary ??= text(record.summary);
  state.firstPrompt ??= userPrompt(record);
  state.project ??= text(record.cwd);
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function readClaudeSessionHeader(path: string): ClaudeSessionHeader {
  let ends: string;
  try {
    ends = readEnds(path);
  } catch {
    return {};
  }
  const records = ends.split("\n").map(parseRecord).filter((record) => record !== undefined);
  return claudeSessionHeader(records);
}

export function claudeSessionHeader(records: Record<string, unknown>[]): ClaudeSessionHeader {
  const state: HeaderState = {};
  for (const record of records) absorb(state, record);
  const title = state.customTitle ?? state.aiTitle ?? state.summary ?? state.firstPrompt;
  return {
    ...(title ? { title: title.slice(0, 120) } : {}),
    ...(state.project ? { project: state.project } : {}),
  };
}
