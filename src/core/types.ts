export type Source = 'codex' | 'claude' | 'opencode' | 'cursor' | 'chatgpt' | 'generic';
export type AgentCli = 'claude' | 'codex' | 'opencode' | 'cursor';
export interface Message { id: string; sessionId: string; ordinal: number; role: 'user' | 'assistant'; text: string; timestamp: string | null }
export interface Session {
  id: string; externalId: string | null; title: string; source: Source; project: string | null;
  createdAt: string; importedAt: string; messageCount: number; characterCount: number; redactions: number;
}
export interface SessionDetail extends Session { messages: Message[] }
export interface Specialist {
  id: string; name: string; description: string; brief: string; tags: string[]; cli: AgentCli;
  sessionIds: string[]; createdAt: string; updatedAt: string; revision: number; archived: boolean;
  sourceCharacters: number;
}
export interface Evidence { id: string; sessionId: string; sessionTitle: string; source: Source; ordinal: number; role: 'user' | 'assistant'; quote: string; timestamp: string | null }
export interface Match { specialist: Specialist; score: number; reasons: string[] }
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface Consultation {
  id: string; specialistId: string; specialistName: string; question: string; mode: 'answer' | 'context';
  cli: AgentCli; status: RunStatus; answer: string; evidence: Evidence[]; context: string;
  error: string | null; createdAt: string; completedAt: string | null; durationMs: number | null;
  briefRevision: number;
}
export interface RunEvent { id: number; runId: string; type: 'status' | 'output'; text: string; createdAt: string }
export interface Library { sessions: Session[]; specialists: Specialist[]; consultations: Consultation[] }
export interface ImportResult { sessions: Session[]; duplicates: number; redactions: number }
