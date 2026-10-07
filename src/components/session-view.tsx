'use client';
import { useEffect, useState } from 'react';
import { ArrowRight, ChatCircle, Trash, FileText } from '@phosphor-icons/react';
import type { Session, SessionDetail } from '@/core/types';
import { api, Badge, Button, counted, Dialog, EmptyState, ErrorNotice, sourceNames } from './ui';
export function SessionView({ sessionId, highlight, onClose, onCreate, onDeleted }: { sessionId: string; highlight?: number; onClose: () => void; onCreate: (ids: string[]) => void; onDeleted: () => void }) {
  const [session, setSession] = useState<SessionDetail | null>(null); const [error, setError] = useState(''); const [confirm, setConfirm] = useState(false); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api<SessionDetail>(`/api/sessions/${sessionId}`).then(data => { if (active) setSession(data); }).catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [sessionId]);
  useEffect(() => { if (session && highlight !== undefined) document.getElementById(`message-${highlight}`)?.scrollIntoView({ block: 'center' }); }, [session, highlight]);
  async function remove() {
    setBusy(true);
    try { await api(`/api/sessions/${sessionId}`, { method: 'DELETE' }); onDeleted(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete this session.'); setConfirm(false); }
    finally { setBusy(false); }
  }
  return <Dialog title={session?.title ?? 'Saved session'} onClose={onClose} wide>
    <div className="modal-body stack">
      {session && <><div className="session-facts"><Badge>{sourceNames[session.source]}</Badge><span>{counted(session.messageCount, 'message')}</span><span>{session.characterCount.toLocaleString()} characters</span></div>{session.project && <p className="muted break-word">{session.project}</p>}
        <div className="transcript">{session.messages.map(message => <article id={`message-${message.ordinal}`} className={`transcript-message ${message.role === 'assistant' ? 'assistant-message' : ''} ${highlight === message.ordinal ? 'highlight-message' : ''}`} key={message.id}><div className="message-speaker"><ChatCircle size={16} aria-hidden="true" />{message.role === 'assistant' ? sourceNames[session.source] : 'You'}<span className="muted">Message {message.ordinal + 1}</span></div><p dir="auto">{message.text}</p></article>)}</div>
      </>}
      {!session && !error && <p role="status">Loading the saved transcript…</p>}
      {error && <ErrorNotice message={error} />}
      {confirm && <div className="delete-confirm"><p>Delete this imported copy? The original session file will remain unchanged.</p><Button variant="danger" busy={busy} onClick={remove}>Delete imported session</Button><Button onClick={() => setConfirm(false)}>Keep session</Button></div>}
    </div>
    <div className="modal-footer"><Button variant="ghost" onClick={() => setConfirm(true)}><Trash size={16} aria-hidden="true" />Delete imported copy</Button><Button variant="primary" disabled={!session} onClick={() => onCreate([sessionId])}>Create specialist <ArrowRight size={16} aria-hidden="true" /></Button></div>
  </Dialog>;
}
export function SessionsPanel({ sessions, onImport, onSelect, onCreate }: { sessions: Session[]; onImport: () => void; onSelect: (id: string) => void; onCreate: (ids: string[]) => void }) {
  const [query, setQuery] = useState(''); const [selected, setSelected] = useState(new Set<string>());
  const selectedIds = sessions.filter(session => selected.has(session.id)).map(session => session.id);
  const visible = sessions.filter(session => `${session.title} ${session.project ?? ''} ${sourceNames[session.source]}`.toLowerCase().includes(query.toLowerCase()));
  if (!sessions.length) return <EmptyState icon={<FileText size={44} weight="light" />} title="No sessions imported"><p>Choose saved coding sessions to turn their context into a specialist.</p><Button variant="primary" onClick={onImport}>Import sessions</Button></EmptyState>;
  return <div className="panel-content"><div className="list-toolbar"><label className="search-input"><span className="sr-only">Search imported sessions</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search sessions" /></label><Button disabled={!selectedIds.length} onClick={() => onCreate(selectedIds)}>Create from {selectedIds.length ? counted(selectedIds.length, 'session') : 'selected sessions'}</Button></div>
    <div className="session-table"><div className="table-heading"><span>Session</span><span>Agent</span><span>Messages</span></div>{visible.map(session => <div className="session-table-row" key={session.id}><label className="session-select"><span className="sr-only">Select {session.title}</span><input type="checkbox" checked={selected.has(session.id)} onChange={() => setSelected(previous => { const next = new Set(previous); if (next.has(session.id)) next.delete(session.id); else if (next.size < 30) next.add(session.id); return next; })} /></label><button className="session-title" onClick={() => onSelect(session.id)}><strong>{session.title}</strong><span>{session.project ?? new Date(session.createdAt).toLocaleDateString()}</span></button><span className="text-sm muted">{sourceNames[session.source]}</span><span className="tabular text-sm muted">{session.messageCount}</span></div>)}</div>
    {!visible.length && <p className="loading-state">No sessions match your search.</p>}
  </div>;
}
