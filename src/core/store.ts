import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import { openDatabase, transaction } from './database';
import { parseSession, type ParsedSession } from './importers';
import { redactCredentials } from './redaction';
import { AppError, specialistInput, specialistUpdate } from './validation';
import type { Consultation, Evidence, ImportResult, Library, Message, RunEvent, Session, SessionDetail, Specialist } from './types';
import type { z } from 'zod';

const sessionColumns = `id, external_id AS externalId, title, source, project, created_at AS createdAt,
 imported_at AS importedAt, message_count AS messageCount, character_count AS characterCount, redactions`;
const specialistColumns = `id, name, description, brief, tags, cli, created_at AS createdAt,
 updated_at AS updatedAt, revision, archived`;
const consultationColumns = `id, specialist_id AS specialistId, specialist_name AS specialistName,
 question, mode, cli, status, answer, evidence, context, error, created_at AS createdAt,
 completed_at AS completedAt, duration_ms AS durationMs, brief_revision AS briefRevision`;
function rows<T>(statement: StatementSync, ...values: SQLInputValue[]): T[] { return statement.all(...values) as unknown as T[]; }
function row<T>(statement: StatementSync, ...values: SQLInputValue[]): T | undefined { return statement.get(...values) as unknown as T | undefined; }
type SpecialistRow = Omit<Specialist, 'tags' | 'archived' | 'sessionIds' | 'sourceCharacters'> & { tags: string; archived: number };
type ConsultationRow = Omit<Consultation, 'evidence'> & { evidence: string };
interface NormalizedSession { parsed: ParsedSession; messages: ParsedSession['messages']; fingerprint: string; redactions: number; characters: number }
function normalizeSession(parsed: ParsedSession): NormalizedSession {
  let redactions = 0;
  const clean = (value: string) => { const result = redactCredentials(value); redactions += result.count; return result.text; };
  const metadata = { ...parsed, title: clean(parsed.title), project: parsed.project ? clean(parsed.project) : undefined,
    externalId: parsed.externalId ? clean(parsed.externalId) : undefined };
  const messages = parsed.messages.map(message => {
    const result = redactCredentials(message.text); redactions += result.count;
    return { ...message, text: result.text };
  });
  const fingerprint = createHash('sha256').update(JSON.stringify({ source: parsed.source, externalId: parsed.externalId, messages: messages.map(m => [m.role, m.text]) })).digest('hex');
  return { parsed: metadata, messages, fingerprint, redactions, characters: messages.reduce((sum, message) => sum + message.text.length, 0) };
}
function cleanSpecialist<T extends z.output<typeof specialistInput>>(data: T): T {
  return { ...data, name: redactCredentials(data.name).text, description: redactCredentials(data.description).text,
    brief: redactCredentials(data.brief).text, tags: data.tags.map(tag => redactCredentials(tag).text) };
}
export class LibraryStore {
  constructor(public db: DatabaseSync = openDatabase()) {}
  close() { this.db.close(); }
  library(): Library { return { sessions: this.sessions(), specialists: this.specialists(), consultations: this.consultations() }; }
  sessions(): Session[] { return rows<Session>(this.db.prepare(`SELECT ${sessionColumns} FROM sessions ORDER BY imported_at DESC, id`)); }
  session(id: string): SessionDetail {
    const session = row<Session>(this.db.prepare(`SELECT ${sessionColumns} FROM sessions WHERE id = ?`), id);
    if (!session) throw new AppError('Session not found. Refresh the library and select it again.', 404);
    return { ...session, messages: this.messages([id]) };
  }
  messages(sessionIds: string[]): Message[] {
    if (!sessionIds.length) return [];
    return rows<Message>(this.db.prepare(`SELECT id, session_id AS sessionId, ordinal, role, text, timestamp
      FROM messages WHERE session_id IN (${sessionIds.map(() => '?').join(',')}) ORDER BY session_id, ordinal`), ...sessionIds);
  }
  import(text: string, filename: string): ImportResult {
    const parsed = parseSession(text, filename);
    if (parsed.length > 100) throw new AppError('This export contains more than 100 sessions. Split the export into smaller files.');
    const normalized = parsed.map(normalizeSession);
    return transaction(this.db, () => {
      const sessions: Session[] = []; let duplicates = 0; let redactions = 0;
      for (const item of normalized) {
        const existing = row<Session>(this.db.prepare(`SELECT ${sessionColumns} FROM sessions WHERE fingerprint = ?`), item.fingerprint);
        if (existing) { duplicates++; sessions.push(existing); continue; }
        const id = this.insertSession(item); sessions.push(this.session(id)); redactions += item.redactions;
      }
      return { sessions, duplicates, redactions };
    });
  }
  private insertSession(item: NormalizedSession): string {
    const id = randomUUID(); const now = new Date().toISOString(); const { parsed } = item;
    this.db.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, item.fingerprint, parsed.externalId ?? null, redactCredentials(parsed.title).text.slice(0, 200), parsed.source,
      parsed.project ? redactCredentials(parsed.project).text.slice(0, 500) : null, validDate(parsed.createdAt, now), now,
      item.messages.length, item.characters, item.redactions
    );
    const statement = this.db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)');
    item.messages.forEach((message, ordinal) => statement.run(randomUUID(), id, ordinal, message.role, message.text, message.timestamp ?? null));
    return id;
  }
  specialists(includeArchived = true): Specialist[] {
    return rows<SpecialistRow>(this.db.prepare(`SELECT ${specialistColumns} FROM specialists ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY updated_at DESC, id`)).map(item => this.hydrateSpecialist(item));
  }
  specialist(id: string): Specialist {
    const item = row<SpecialistRow>(this.db.prepare(`SELECT ${specialistColumns} FROM specialists WHERE id = ?`), id);
    if (!item) throw new AppError('Specialist not found. Refresh the library and select it again.', 404);
    return this.hydrateSpecialist(item);
  }
  private hydrateSpecialist(item: SpecialistRow): Specialist {
    const links = rows<{ sessionId: string; characters: number }>(this.db.prepare(`SELECT s.id AS sessionId, s.character_count AS characters FROM sessions s
      JOIN specialist_sessions ss ON ss.session_id = s.id WHERE ss.specialist_id = ? ORDER BY s.created_at, s.id`), item.id);
    return { ...item, archived: Boolean(item.archived), tags: JSON.parse(item.tags) as string[], sessionIds: links.map(link => link.sessionId), sourceCharacters: links.reduce((total, link) => total + link.characters, 0) };
  }
  createSpecialist(input: z.input<typeof specialistInput>): Specialist {
    const data = cleanSpecialist(specialistInput.parse(input)); const id = randomUUID(); const now = new Date().toISOString();
    return transaction(this.db, () => {
      data.sessionIds.forEach(sessionId => this.session(sessionId));
      this.db.prepare('INSERT INTO specialists (id, name, description, brief, tags, cli, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, data.name, data.description, redactCredentials(data.brief).text, JSON.stringify(data.tags), data.cli, now, now);
      this.replaceLinks(id, data.sessionIds); this.saveVersion(id); return this.specialist(id);
    });
  }
  updateSpecialist(id: string, input: z.input<typeof specialistUpdate>): Specialist {
    const data = cleanSpecialist(specialistUpdate.parse(input));
    return transaction(this.db, () => {
      const old = this.specialist(id);
      if (old.revision !== data.revision) throw new AppError('This specialist changed in another window. Refresh it before saving your edits.', 409);
      data.sessionIds.forEach(sessionId => this.session(sessionId));
      this.db.prepare('UPDATE specialists SET name=?, description=?, brief=?, tags=?, cli=?, revision=revision+1, updated_at=? WHERE id=?')
        .run(data.name, data.description, redactCredentials(data.brief).text, JSON.stringify(data.tags), data.cli, new Date().toISOString(), id);
      this.replaceLinks(id, data.sessionIds); this.saveVersion(id); return this.specialist(id);
    });
  }
  private replaceLinks(id: string, sessionIds: string[]) {
    this.db.prepare('DELETE FROM specialist_sessions WHERE specialist_id = ?').run(id);
    const statement = this.db.prepare('INSERT INTO specialist_sessions VALUES (?, ?)');
    [...new Set(sessionIds)].forEach(sessionId => statement.run(id, sessionId));
  }
  private saveVersion(id: string) {
    const snapshot = this.specialist(id);
    this.db.prepare('INSERT INTO brief_versions VALUES (?, ?, ?, ?)').run(id, snapshot.revision, JSON.stringify(snapshot), snapshot.updatedAt);
  }
  versions(id: string): Specialist[] {
    this.specialist(id);
    return rows<{ snapshot: string }>(this.db.prepare('SELECT snapshot FROM brief_versions WHERE specialist_id = ? ORDER BY revision DESC LIMIT 30'), id).map(item => JSON.parse(item.snapshot) as Specialist);
  }
  archiveSpecialist(id: string, archived: boolean): Specialist {
    this.specialist(id);
    this.db.prepare('UPDATE specialists SET archived=?, updated_at=? WHERE id=?').run(Number(archived), new Date().toISOString(), id);
    return this.specialist(id);
  }
  deleteSession(id: string) {
    this.session(id);
    const references = row<{ count: number }>(this.db.prepare('SELECT count(*) AS count FROM specialist_sessions WHERE session_id = ?'), id)?.count ?? 0;
    if (references) throw new AppError('This session supports a specialist. Remove it from that specialist before deleting it.', 409);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }
  createConsultation(input: Pick<Consultation, 'specialistId' | 'question' | 'mode' | 'cli' | 'evidence' | 'context'> & { owner?: string }): Consultation {
    const specialist = this.specialist(input.specialistId);
    if (specialist.archived) throw new AppError('Restore this specialist before asking it a question.', 409);
    const id = randomUUID();
    transaction(this.db, () => {
      this.recoverAbandonedRuns();
      const active = row<{ count: number }>(this.db.prepare("SELECT count(*) AS count FROM consultations WHERE status IN ('queued','running')"))?.count ?? 0;
      if (input.mode === 'answer' && active >= 10) throw new AppError('The specialist queue is full. Let a consultation finish before asking again.', 429);
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO consultations (id, specialist_id, specialist_name, question, mode, cli, status, evidence, context, created_at, brief_revision, owner, heartbeat)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`).run(id, specialist.id, specialist.name, redactCredentials(input.question).text, input.mode, input.cli,
          JSON.stringify(input.evidence), redactCredentials(input.context).text, now, specialist.revision, input.owner ?? null, input.owner ? now : null);
    });
    return this.consultation(id);
  }
  consultation(id: string): Consultation {
    const item = row<ConsultationRow>(this.db.prepare(`SELECT ${consultationColumns} FROM consultations WHERE id = ?`), id);
    if (!item) throw new AppError('Consultation not found. Refresh the run history.', 404);
    return { ...item, evidence: JSON.parse(item.evidence) as Evidence[] };
  }
  consultations(limit = 100): Consultation[] {
    return rows<ConsultationRow>(this.db.prepare(`SELECT ${consultationColumns} FROM consultations ORDER BY created_at DESC LIMIT ?`), limit).map(item => ({ ...item, evidence: JSON.parse(item.evidence) as Evidence[] }));
  }
  transitionRun(id: string, status: Consultation['status'], fields: { answer?: string; error?: string; durationMs?: number } = {}): Consultation {
    const terminal = ['completed', 'failed', 'cancelled'].includes(status);
    this.db.prepare(`UPDATE consultations SET status=?, answer=COALESCE(?, answer), error=COALESCE(?, error), duration_ms=COALESCE(?, duration_ms),
      completed_at=CASE WHEN ? THEN ? ELSE completed_at END WHERE id=? AND status IN ('queued', 'running')`)
      .run(status, fields.answer ?? null, fields.error ?? null, fields.durationMs ?? null, Number(terminal), new Date().toISOString(), id);
    return this.consultation(id);
  }
  claimRun(id: string, owner: string): boolean {
    return transaction(this.db, () => {
      this.recoverAbandonedRuns();
      const active = row<{ count: number }>(this.db.prepare("SELECT count(*) AS count FROM consultations WHERE status='running'"))?.count ?? 0;
      if (active >= 2) return false;
      const next = row<{ id: string }>(this.db.prepare("SELECT id FROM consultations WHERE status='queued' AND mode='answer' ORDER BY created_at, rowid LIMIT 1"));
      if (next?.id !== id) return false;
      return Number(this.db.prepare("UPDATE consultations SET status='running', owner=?, heartbeat=? WHERE id=? AND status='queued' AND (owner IS NULL OR owner=?)").run(owner, new Date().toISOString(), id, owner).changes) === 1;
    });
  }
  heartbeatRun(id: string, owner: string) {
    this.db.prepare("UPDATE consultations SET owner=?, heartbeat=? WHERE id=? AND status IN ('queued','running') AND (owner IS NULL OR owner=?)")
      .run(owner, new Date().toISOString(), id, owner);
  }
  recoverAbandonedRuns(): number {
    const cutoff = new Date(Date.now() - 30000).toISOString();
    return Number(this.db.prepare(`UPDATE consultations SET status='failed', error='The previous agent process ended. Ask again to start a fresh consultation.', completed_at=?
      WHERE status IN ('queued','running') AND COALESCE(heartbeat, created_at) < ?`).run(new Date().toISOString(), cutoff).changes);
  }
  addEvent(runId: string, event: Pick<RunEvent, 'type' | 'text'>) {
    this.db.prepare('INSERT INTO run_events (run_id, type, text, created_at) VALUES (?, ?, ?, ?)').run(runId, event.type, redactCredentials(event.text).text.slice(0, 10000), new Date().toISOString());
  }
  events(runId: string, after = 0): RunEvent[] {
    return rows<RunEvent>(this.db.prepare('SELECT id, run_id AS runId, type, text, created_at AS createdAt FROM run_events WHERE run_id=? AND id>? ORDER BY id LIMIT 200'), runId, after);
  }
}
function validDate(value: string | undefined, fallback: string): string { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback; }
