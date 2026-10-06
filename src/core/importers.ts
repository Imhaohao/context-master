/**
 * Import the visible conversation turns from common agent transcript formats.
 *
 * Imported text is treated as data throughout this module. In particular, no
 * transcript value is evaluated, interpreted as a path, or executed.
 */

export type SessionSource = "codex" | "claude" | "opencode" | "cursor" | "chatgpt" | "generic";

export interface ParsedMessage {
  role: "user" | "assistant";
  text: string;
  timestamp?: string;
}

export interface ParsedSession {
  externalId?: string;
  title: string;
  source: SessionSource;
  project?: string;
  createdAt?: string;
  messages: ParsedMessage[];
}

const MAX_INPUT_BYTES = 8 * 1024 * 1024;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

interface MessageCandidate {
  message: ParsedMessage;
  representation: "event" | "response";
}

interface ConversationNode {
  id: string;
  parent?: string;
  message?: JsonObject;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getValue(object: JsonObject, key: string): JsonValue | undefined {
  return object[key];
}

function getString(object: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = getValue(object, key);
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function getObject(object: JsonObject, ...keys: string[]): JsonObject | undefined {
  for (const key of keys) {
    const value = getValue(object, key);
    if (isJsonObject(value)) {
      return value;
    }
  }
  return undefined;
}

function getArray(object: JsonObject, ...keys: string[]): JsonValue[] | undefined {
  for (const key of keys) {
    const value = getValue(object, key);
    if (Array.isArray(value)) {
      return value;
    }
  }
  return undefined;
}

function toTimestamp(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  return undefined;
}

function getTimestamp(object: JsonObject): string | undefined {
  const time = getObject(object, "time");
  return toTimestamp(getValue(object, "timestamp")) ??
    toTimestamp(getValue(object, "created_at")) ??
    toTimestamp(getValue(object, "create_time")) ??
    (time ? toTimestamp(getValue(time, "created") ?? getValue(time, "created_at")) : undefined);
}

function basename(filename: string): string {
  const lastPart = filename.split(/[\\/]/u).pop() ?? filename;
  const withoutExtension = lastPart.replace(/\.[^.]*$/u, "");
  return withoutExtension.trim() || "Imported session";
}

function fallbackTitle(filename: string, messages: ParsedMessage[]): string {
  const name = basename(filename);
  if (name !== "Imported session") {
    return name;
  }
  const firstText = messages[0]?.text.replace(/\s+/gu, " ").trim();
  if (firstText) {
    return firstText.length > 80 ? `${firstText.slice(0, 77)}...` : firstText;
  }
  return "Imported session";
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/gu, "\n").replace(/[ \t]+\n/gu, "\n").trim();
}

function contentText(value: JsonValue | undefined, acceptedTypes?: Set<string>): string {
  if (typeof value === "string") {
    return normalizeText(value);
  }
  if (!Array.isArray(value)) {
    return "";
  }

  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isJsonObject(part)) {
      continue;
    }
    const partType = getString(part, "type");
    if (acceptedTypes && (!partType || !acceptedTypes.has(partType))) {
      continue;
    }
    const text = getString(part, "text", "content");
    if (text) {
      parts.push(text);
    }
  }
  return normalizeText(parts.join("\n"));
}

function roleFromValue(value: JsonValue | undefined): "user" | "assistant" | undefined {
  if (value !== "user" && value !== "assistant") {
    return undefined;
  }
  return value;
}

function visibleMessage(
  role: "user" | "assistant" | undefined,
  text: string,
  timestamp?: string,
): ParsedMessage | undefined {
  const normalized = normalizeText(text);
  if (!role || normalized === "") {
    return undefined;
  }
  return timestamp ? { role, text: normalized, timestamp } : { role, text: normalized };
}

function candidateFrom(
  role: "user" | "assistant" | undefined,
  text: string,
  timestamp: string | undefined,
  representation: MessageCandidate["representation"],
): MessageCandidate | undefined {
  const message = visibleMessage(role, text, timestamp);
  return message ? { message, representation } : undefined;
}

function dedupeCandidates(candidates: MessageCandidate[]): ParsedMessage[] {
  const seenStable = new Set<string>();
  const seenRepresentation = new Map<string, Set<MessageCandidate["representation"]>>();
  const messages: ParsedMessage[] = [];

  for (const candidate of candidates) {
    const { message, representation } = candidate;
    const stableKey = `${message.role}\u0000${message.text}\u0000${message.timestamp ?? ""}`;
    const representationKey = `${message.role}\u0000${message.text}`;
    if (seenStable.has(stableKey)) {
      continue;
    }
    const representations = seenRepresentation.get(representationKey);
    if (representations && !representations.has(representation)) {
      // Codex writes the same turn as both an event_msg and a response_item.
      // Repeated turns from one representation are retained when timestamps
      // distinguish them.
      continue;
    }
    seenStable.add(stableKey);
    if (representations) {
      representations.add(representation);
    } else {
      seenRepresentation.set(representationKey, new Set([representation]));
    }
    messages.push(message);
  }
  return messages;
}

function sessionMetadata(
  filename: string,
  source: SessionSource,
  messages: ParsedMessage[],
  metadata: JsonObject | undefined,
): ParsedSession {
  const title = metadata ? getString(metadata, "title", "name") : undefined;
  const externalId = metadata ? getString(metadata, "externalId", "id", "session_id", "sessionId", "sessionID", "conversation_id", "conversationId", "composerId") : undefined;
  const project = metadata ? getString(metadata, "project", "project_name", "cwd", "directory", "workspace", "projectID", "project_id") : undefined;
  const createdAt = metadata ? getTimestamp(metadata) : undefined;
  const session: ParsedSession = {
    title: title ?? fallbackTitle(filename, messages),
    source,
    messages,
  };
  if (externalId) session.externalId = externalId;
  if (project) session.project = project;
  if (createdAt) session.createdAt = createdAt;
  return session;
}

function parseCodexRecords(records: JsonObject[], filename: string): ParsedSession {
  const candidates: MessageCandidate[] = [];
  let metadata: JsonObject | undefined;

  for (const record of records) {
    const recordType = getString(record, "type");
    const timestamp = getTimestamp(record);
    const payload = getObject(record, "payload", "data") ?? record;
    if (recordType === "session_meta") {
      metadata = payload;
      continue;
    }
    if (recordType === "response_item" || getString(payload, "type") === "message") {
      const role = roleFromValue(getValue(payload, "role"));
      const text = contentText(getValue(payload, "content"), new Set(["input_text", "output_text", "text"]));
      const candidate = candidateFrom(role, text, timestamp ?? getTimestamp(payload), "response");
      if (candidate) candidates.push(candidate);
      continue;
    }
    if (recordType === "event_msg") {
      const eventType = getString(payload, "type");
      const role = eventType === "user_message" ? "user" : eventType === "agent_message" ? "assistant" : undefined;
      const text = getString(payload, "message", "text", "content") ?? "";
      const candidate = candidateFrom(role, text, timestamp ?? getTimestamp(payload), "event");
      if (candidate) candidates.push(candidate);
    }
  }

  const messages = dedupeCandidates(candidates);
  return sessionMetadata(filename, "codex", messages, metadata);
}

function isClaudeRecord(record: JsonObject): boolean {
  const type = getString(record, "type");
  return (type === "user" || type === "assistant") &&
    (isJsonObject(getValue(record, "message")) || typeof getValue(record, "message") === "string");
}

function parseClaudeRecords(records: JsonObject[], filename: string): ParsedSession {
  const messages: ParsedMessage[] = [];
  let metadata: JsonObject | undefined;

  for (const record of records) {
    const recordType = getString(record, "type");
    if (recordType !== "user" && recordType !== "assistant") {
      if (!metadata && (getString(record, "sessionId", "session_id") || getString(record, "cwd", "project"))) {
        metadata = record;
      }
      continue;
    }
    const nested = getObject(record, "message");
    const role = roleFromValue(getValue(nested ?? record, "role")) ?? (recordType === "user" ? "user" : "assistant");
    const content = nested ? getValue(nested, "content") : getValue(record, "content");
    const text = contentText(content, new Set(["text"]));
    const message = visibleMessage(role, text, getTimestamp(record) ?? (nested ? getTimestamp(nested) : undefined));
    if (message) messages.push(message);
    if (!metadata) metadata = record;
  }

  return sessionMetadata(filename, "claude", messages, metadata);
}

function genericMessage(object: JsonObject): ParsedMessage | undefined {
  const role = roleFromValue(getValue(object, "role")) ??
    roleFromValue(getValue(object, "speaker")) ??
    roleFromValue(getValue(object, "type"));
  const text = contentText(
    getValue(object, "content") ?? getValue(object, "text") ?? getValue(object, "parts"),
    new Set(["text"]),
  );
  return visibleMessage(role, text, getTimestamp(object));
}

function parseGenericRecords(
  records: JsonObject[],
  filename: string,
  metadata?: JsonObject,
  source: SessionSource = "generic",
): ParsedSession {
  const messages: ParsedMessage[] = [];
  for (const record of records) {
    const direct = genericMessage(record);
    if (direct) messages.push(direct);
    const nestedMessages = getArray(record, "messages");
    if (nestedMessages) {
      for (const nested of nestedMessages) {
        if (isJsonObject(nested)) {
          const message = genericMessage(nested);
          if (message) messages.push(message);
        }
      }
    }
  }
  return sessionMetadata(filename, source, messages, metadata);
}

function isOpenCodeRecord(record: JsonObject): boolean {
  return Boolean(getString(record, "sessionID", "session_id", "projectID", "project_id", "messageID", "message_id"));
}

function isCursorRecord(record: JsonObject): boolean {
  return Boolean(getString(record, "conversationId", "conversation_id", "composerId", "composer_id", "agentId"));
}

function parseOpenCodeRecords(records: JsonObject[], filename: string): ParsedSession {
  const metadata = records.find((record) => getString(record, "title", "name") || !genericMessage(record));
  return parseGenericRecords(records, filename, metadata, "opencode");
}

function parseCursorRecords(records: JsonObject[], filename: string): ParsedSession {
  const metadata = records.find((record) => getString(record, "title", "name", "conversationId", "conversation_id", "composerId"));
  return parseGenericRecords(records, filename, metadata, "cursor");
}

function declaredSessionSource(value: JsonObject): SessionSource | undefined {
  const source = getString(value, "source");
  if (source === "codex" || source === "claude" || source === "opencode" || source === "cursor" || source === "chatgpt" || source === "generic") {
    return source;
  }
  return undefined;
}

function chatPartText(content: JsonValue | undefined): string {
  if (typeof content === "string") {
    return normalizeText(content);
  }
  if (!isJsonObject(content)) {
    return "";
  }
  const parts = getArray(content, "parts");
  if (parts) {
    return contentText(parts);
  }
  return contentText(getValue(content, "text"));
}

function chatNode(object: JsonObject, id: string): ConversationNode {
  const parent = getString(object, "parent");
  return {
    id,
    ...(parent ? { parent } : {}),
    ...(getObject(object, "message") ? { message: getObject(object, "message") } : {}),
  };
}

function chatNodes(mapping: JsonObject): Map<string, ConversationNode> {
  const nodes = new Map<string, ConversationNode>();
  for (const [id, value] of Object.entries(mapping)) {
    if (isJsonObject(value)) nodes.set(id, chatNode(value, id));
  }
  return nodes;
}

function nodeHasChild(nodes: Map<string, ConversationNode>, id: string): boolean {
  for (const node of nodes.values()) {
    if (node.parent === id) return true;
  }
  return false;
}

function selectedChatCursor(conversation: JsonObject, nodes: Map<string, ConversationNode>): string | undefined {
  const currentNode = getString(conversation, "current_node");
  if (currentNode && nodes.has(currentNode)) return currentNode;
  const candidates = [...nodes.values()].filter((node) => !nodeHasChild(nodes, node.id));
  if (candidates.length > 0) return candidates[candidates.length - 1].id;
  const ids = [...nodes.keys()];
  return ids[ids.length - 1];
}

function chatChain(nodes: Map<string, ConversationNode>, cursor: string | undefined): ConversationNode[] {
  if (!cursor) return [];
  const chain: ConversationNode[] = [];
  const visited = new Set<string>();
  let current: string | undefined = cursor;
  while (current && !visited.has(current)) {
    const node = nodes.get(current);
    if (!node) break;
    visited.add(current);
    chain.push(node);
    current = node.parent;
  }
  chain.reverse();
  return chain;
}

function chatMessage(node: ConversationNode): ParsedMessage | undefined {
  const message = node.message;
  if (!message) return undefined;
  const role = roleFromValue(getValue(getObject(message, "author") ?? message, "role"));
  return visibleMessage(role, chatPartText(getValue(message, "content")), getTimestamp(message));
}

function chatMessages(conversation: JsonObject): ParsedMessage[] {
  const mapping = getObject(conversation, "mapping");
  if (!mapping) return [];
  const nodes = chatNodes(mapping);
  return chatChain(nodes, selectedChatCursor(conversation, nodes))
    .map(chatMessage)
    .filter((message): message is ParsedMessage => Boolean(message));
}

function parseChatGptConversation(conversation: JsonObject, filename: string): ParsedSession {
  const messages = chatMessages(conversation);
  return sessionMetadata(filename, "chatgpt", messages, conversation);
}

function parsePlainText(text: string, filename: string): ParsedSession {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const messages: ParsedMessage[] = [];
  let activeRole: "user" | "assistant" | undefined;
  let activeTimestamp: string | undefined;
  let buffer: string[] = [];

  const flush = (): void => {
    const message = visibleMessage(activeRole, buffer.join("\n"), activeTimestamp);
    if (message) messages.push(message);
    buffer = [];
  };

  for (const line of lines) {
    const heading = /^\s*(?:#{1,6}\s*)?(user|human|assistant|ai)\s*:?\s*$/iu.exec(line);
    const prefixed = /^\s*(?:\[([^\]]+)\]\s*)?(user|human|assistant|ai)\s*:\s*(.*)$/iu.exec(line);
    if (heading) {
      flush();
      activeRole = /^(?:user|human)$/iu.test(heading[1]) ? "user" : "assistant";
      activeTimestamp = undefined;
      continue;
    }
    if (prefixed) {
      flush();
      activeRole = /^(?:user|human)$/iu.test(prefixed[2]) ? "user" : "assistant";
      activeTimestamp = prefixed[1]?.trim() || undefined;
      if (prefixed[3].trim()) buffer.push(prefixed[3]);
      continue;
    }
    if (activeRole) buffer.push(line);
  }
  flush();

  if (messages.length === 0 && text.trim()) {
    messages.push({ role: "user", text: normalizeText(text) });
  }
  return sessionMetadata(filename, "generic", messages, undefined);
}

function parseJsonArray(value: JsonValue[], filename: string): ParsedSession[] {
  const conversations = value.filter(isJsonObject);
  if (conversations.some((entry) => getObject(entry, "mapping"))) {
    return conversations
      .filter((entry) => getObject(entry, "mapping"))
      .map((entry) => parseChatGptConversation(entry, filename));
  }
  const declared = conversations.map(declaredSessionSource);
  if (declared.length > 0 && declared.every((source): source is SessionSource => Boolean(source))) {
    return conversations.map((entry, index) => parseGenericRecords([entry], filename, entry, declared[index]));
  }
  if (conversations.some(isOpenCodeRecord) || /opencode/iu.test(filename)) {
    return [parseOpenCodeRecords(conversations, filename)];
  }
  if (conversations.some(isCursorRecord) || /cursor/iu.test(filename)) {
    return [parseCursorRecords(conversations, filename)];
  }
  return [parseGenericRecords(conversations, filename)];
}

function parseJsonObject(value: JsonObject, filename: string): ParsedSession[] {
  const mapping = getObject(value, "mapping");
  if (mapping) return [parseChatGptConversation(value, filename)];

  const declaredSource = declaredSessionSource(value);
  if (declaredSource) return [parseGenericRecords([value], filename, value, declaredSource)];

  if (isOpenCodeRecord(value) || /opencode/iu.test(filename)) {
    return [parseOpenCodeRecords([value], filename)];
  }
  if (isCursorRecord(value) || /cursor/iu.test(filename)) {
    return [parseCursorRecords([value], filename)];
  }

  const messages = getArray(value, "messages");
  if (messages) return [parseGenericRecords([value], filename, value)];

  return [parseGenericRecords([value], filename, value)];
}

function parseJsonValue(value: JsonValue, filename: string): ParsedSession[] {
  if (Array.isArray(value)) return parseJsonArray(value, filename);
  if (!isJsonObject(value)) return [parseGenericRecords([], filename)];
  return parseJsonObject(value, filename);
}

function parseJsonLines(lines: JsonObject[], filename: string): ParsedSession {
  if (lines.some((line) => getString(line, "type") === "session_meta" || getString(line, "type") === "response_item" || getString(line, "type") === "event_msg")) {
    return parseCodexRecords(lines, filename);
  }
  if (lines.some(isClaudeRecord) || /claude/iu.test(filename)) {
    return parseClaudeRecords(lines, filename);
  }
  if (lines.some(isOpenCodeRecord) || /opencode/iu.test(filename)) {
    return parseOpenCodeRecords(lines, filename);
  }
  if (lines.some(isCursorRecord) || /cursor/iu.test(filename)) {
    return parseCursorRecords(lines, filename);
  }
  return parseGenericRecords(lines, filename);
}

function parseJsonText(text: string, filename: string): ParsedSession[] {
  try {
    const parsed = JSON.parse(text) as JsonValue;
    return parseJsonValue(parsed, filename);
  } catch {
    const records: JsonObject[] = [];
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: JsonValue;
      try {
        parsed = JSON.parse(trimmed) as JsonValue;
      } catch {
        throw new Error(`Unsupported session format for ${filename}: invalid JSONL`);
      }
      if (!isJsonObject(parsed)) {
        throw new Error(`Unsupported session format for ${filename}: JSONL records must be objects`);
      }
      records.push(parsed);
    }
    if (records.length === 0) {
      throw new Error(`Unsupported session format for ${filename}: empty JSON`);
    }
    return [parseJsonLines(records, filename)];
  }
}

function inputByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).byteLength;
  }
  return text.length;
}

function ensureMessages(sessions: ParsedSession[], filename: string): ParsedSession[] {
  const withMessages = sessions.filter((session) => session.messages.length > 0);
  if (withMessages.length === 0) {
    throw new Error(`No visible user or assistant messages found in ${filename}`);
  }
  return withMessages;
}

/** Parse one transcript or export file into one or more normalized sessions. */
export function parseSession(text: string, filename: string): ParsedSession[] {
  if (inputByteLength(text) > MAX_INPUT_BYTES) {
    throw new Error(`Session input exceeds 8 MiB limit for ${filename}`);
  }
  if (text.trim() === "") {
    throw new Error(`Unsupported session format for ${filename}: empty input`);
  }

  const trimmed = text.trimStart();
  let sessions: ParsedSession[];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    sessions = parseJsonText(text, filename);
  } else {
    sessions = [parsePlainText(text, filename)];
  }
  return ensureMessages(sessions, filename);
}
