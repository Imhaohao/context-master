'use client';
import { useState } from 'react';
import { ArrowRight, FloppyDisk, ClockCounterClockwise } from '@phosphor-icons/react';
import type { Session, Specialist } from '@/core/types';
import { api, Badge, Button, Dialog, ErrorNotice, Field, requestBody, sourceNames } from './ui';
interface Draft { name: string; description: string; brief: string; tags: string[] }
export function SpecialistEditor({ initial, sessionIds, sessions, specialist, onClose, onSaved }: { initial: Draft; sessionIds: string[]; sessions: Session[]; specialist?: Specialist; onClose: () => void; onSaved: (specialist: Specialist) => void }) {
  const [name, setName] = useState(initial.name); const [description, setDescription] = useState(initial.description);
  const [brief, setBrief] = useState(initial.brief); const [tags, setTags] = useState(initial.tags.join(', '));
  const [cli, setCli] = useState(specialist?.cli ?? 'codex'); const [selected, setSelected] = useState(new Set(sessionIds));
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [versions, setVersions] = useState<Specialist[] | null>(null);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    const input = { name, description, brief, tags: [...new Set(tags.split(',').map(tag => tag.trim()).filter(Boolean))], cli, sessionIds: [...selected], ...(specialist ? { revision: specialist.revision } : {}) };
    try {
      const value = await api<Specialist>(specialist ? `/api/specialists/${specialist.id}` : '/api/specialists', { ...requestBody(input), method: specialist ? 'PATCH' : 'POST' });
      onSaved(value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save. Try again.'); }
    finally { setBusy(false); }
  }
  async function showVersions() {
    if (!specialist) return;
    try { const data = await api<{ versions: Specialist[] }>(`/api/specialists/${specialist.id}`); setVersions(data.versions); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load versions.'); }
  }
  function toggle(id: string) { setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  return <Dialog title={specialist ? 'Edit specialist' : 'Create a specialist'} onClose={onClose} wide>
    <form onSubmit={save}>
      <div className="modal-body stack">
        <div className="form-grid"><Field label="Name"><input value={name} onChange={event => setName(event.target.value)} maxLength={100} required autoFocus /></Field><Field label="Answer with"><select value={cli} onChange={event => setCli(event.target.value as Specialist['cli'])}>{['claude', 'codex', 'opencode', 'cursor'].map(value => <option key={value} value={value}>{sourceNames[value]}</option>)}</select></Field></div>
        <Field label="Specialist scope" hint="Describe the questions this specialist is equipped to answer."><textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={600} rows={2} /></Field>
        <Field label="Saved context" hint="This draft preserves source excerpts. Edit it to keep the decisions and limitations that matter."><textarea className="brief-editor" value={brief} onChange={event => setBrief(event.target.value)} maxLength={12000} rows={10} required /></Field>
        <div className="editor-budget"><span>{brief.length.toLocaleString()} / 12,000 characters</span><span>About {Math.ceil(brief.length / 4).toLocaleString()} tokens, estimated</span></div>
        <Field label="Tags" hint="Separate tags with commas. Use up to 12."><input value={tags} onChange={event => setTags(event.target.value)} maxLength={500} placeholder="database, migrations" /></Field>
        <details className="source-selection"><summary>Linked sessions <Badge>{selected.size}</Badge></summary><div className="source-options">{sessions.map(session => <label key={session.id}><input type="checkbox" checked={selected.has(session.id)} onChange={() => toggle(session.id)} />{session.title}</label>)}</div></details>
        {specialist && <div><Button variant="ghost" type="button" onClick={showVersions}><ClockCounterClockwise aria-hidden="true" size={18} />View saved versions</Button>{versions && <div className="version-list">{versions.map(version => <div key={version.revision}><span>Revision {version.revision}</span><span className="muted text-sm">{new Date(version.updatedAt).toLocaleString()}</span><Button type="button" variant="ghost" onClick={() => { setBrief(version.brief); setName(version.name); setDescription(version.description); setTags(version.tags.join(', ')); setSelected(new Set(version.sessionIds)); setCli(version.cli); }}>Use this version</Button></div>)}</div>}</div>}
        {error && <ErrorNotice message={error} />}
      </div>
      <div className="modal-footer"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" busy={busy}>{specialist ? <FloppyDisk size={16} aria-hidden="true" /> : <ArrowRight size={16} aria-hidden="true" />}{specialist ? 'Save changes' : 'Create specialist'}</Button></div>
    </form>
  </Dialog>;
}
