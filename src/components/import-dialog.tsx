'use client';
import { useEffect, useRef, useState } from 'react';
import { FileArrowUp, MagnifyingGlass, FolderOpen, Check, ArrowRight } from '@phosphor-icons/react';
import { api, Badge, Button, Dialog, ErrorNotice, relativeTime, requestBody, sourceNames } from './ui';
import type { DiscoveredSession } from '@/core/discovery';
import type { ImportResult } from '@/core/types';
interface ImportFile { name: string; text: string }
declare global { interface Window { contextMaster?: { pickFiles: () => Promise<ImportFile[]> } } }
type DiscoveryResult = { sessions: DiscoveredSession[]; sources: { source: string; path: string; available: boolean; detail: string }[]; truncated: boolean };
type FileResult = ImportResult & { name: string; error: string | null };
export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (ids: string[]) => void }) {
  const [mode, setMode] = useState<'discover' | 'files'>('discover');
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const [files, setFiles] = useState<ImportFile[]>([]);
  const [query, setQuery] = useState(''); const [source, setSource] = useState('all');
  const [busy, setBusy] = useState(false); const [scanning, setScanning] = useState(true); const [error, setError] = useState('');
  const [results, setResults] = useState<FileResult[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setScanning(true);
      const parameters = new URLSearchParams({ q: query });
      if (source !== 'all') parameters.set('source', source);
      api<DiscoveryResult>(`/api/discovery?${parameters}`, { signal: controller.signal })
        .then(setDiscovery).catch(cause => { if (!controller.signal.aborted) setError(cause.message); })
        .finally(() => { if (!controller.signal.aborted) setScanning(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, source]);
  async function chooseFiles() {
    setError('');
    try { if (window.contextMaster) setFiles(await window.contextMaster.pickFiles()); else input.current?.click(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open the file picker.'); }
  }
  async function readFiles(list: FileList | null) {
    if (!list) return;
    setFiles([]);
    if (list.length > 20) { setError('Select up to 20 files at a time.'); return; }
    const picked = Array.from(list);
    if (picked.some(file => file.size > 8 * 1024 * 1024)) { setError('Each transcript must be 8 MB or smaller. Split a larger export first.'); return; }
    setError('');
    try { setFiles(await Promise.all(picked.map(async file => ({ name: file.name, text: await file.text() })))); }
    catch { setError('Could not read the selected files. Check their permissions and choose them again.'); }
  }
  async function importSelected() {
    setBusy(true); setError('');
    try {
      const payload = mode === 'discover' ? { ids: [...selected] } : { files };
      const data = await api<{ results: FileResult[] }>(mode === 'discover' ? '/api/discovery' : '/api/import', requestBody(payload));
      setResults(data.results);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Import failed. Try again.'); }
    finally { setBusy(false); }
  }
  function toggle(id: string) { setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else if (next.size < 20) next.add(id); return next; }); }
  const visible = discovery?.sessions.filter(session => (source === 'all' || session.source === source) && `${session.title} ${session.project ?? ''}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  const importedIds = results?.flatMap(result => result.sessions.map(session => session.id)) ?? [];
  if (results) return <Dialog title="Import results" onClose={onClose} wide>
    <div className="modal-body stack"><p className="muted">Imported transcripts are stored locally. Original sessions remain unchanged.</p>
      {results.map((result, index) => <div className="import-result" key={`${result.name}-${index}`}><span>{result.name}</span>{result.error ? <ErrorNotice message={result.error} /> : <span className="success-text"><Check aria-hidden="true" size={16} />{result.sessions.length - result.duplicates} added{result.duplicates ? `, ${result.duplicates} already imported` : ''}{result.redactions ? `, ${result.redactions} credentials redacted` : ''}</span>}</div>)}
    </div><div className="modal-footer"><Button onClick={onClose}>Close</Button><Button variant="primary" disabled={!importedIds.length} onClick={() => onImported([...new Set(importedIds)])}>Create a specialist <ArrowRight size={16} aria-hidden="true" /></Button></div>
  </Dialog>;
  return <Dialog title="Import sessions" onClose={onClose} wide>
    <div className="modal-body stack">
      <div className="segmented"><button aria-pressed={mode === 'discover'} onClick={() => setMode('discover')}><FolderOpen aria-hidden="true" size={18} />Find on this Mac</button><button aria-pressed={mode === 'files'} onClick={() => setMode('files')}><FileArrowUp aria-hidden="true" size={18} />Choose transcript files</button></div>
      {mode === 'discover' ? <>
        <div className="discovery-sources">{discovery?.sources.map(item => <details key={item.source}><summary>{sourceNames[item.source]} <Badge active={item.available}>{item.available ? 'Found' : 'Not found'}</Badge></summary><p>{item.detail}</p><code>{item.path}</code></details>)}</div>
        <div className="search-row"><label className="search-input"><MagnifyingGlass size={18} aria-hidden="true" /><span className="sr-only">Filter discovered sessions</span><input placeholder="Filter by session or project" value={query} onChange={event => setQuery(event.target.value)} maxLength={1000} /></label><label><span className="sr-only">Filter by agent</span><select value={source} onChange={event => setSource(event.target.value)}><option value="all">All agents</option>{['claude', 'codex', 'opencode', 'cursor'].map(value => <option value={value} key={value}>{sourceNames[value]}</option>)}</select></label></div>
        <div className="discovery-list">{scanning ? <p className="loading-state" role="status">Looking for saved sessions…</p> : visible.length ? visible.map(session => <label className={`discovery-item ${selected.has(session.id) ? 'is-selected' : ''}`} key={session.id}><input type="checkbox" checked={selected.has(session.id)} onChange={() => toggle(session.id)} disabled={!selected.has(session.id) && selected.size >= 20} /><span className="min-w-0"><strong>{session.title}</strong><span className="muted text-sm break-word">{session.project ?? sourceNames[session.source]}</span></span><span className="discovery-meta"><span>{sourceNames[session.source]}</span><span>{relativeTime(session.updatedAt)}</span></span></label>) : <p className="loading-state">No sessions match. Choose transcript files to import an export.</p>}</div>
        {discovery?.truncated && <p className="field-hint">Showing recent matches from a bounded scan. Filter by project or agent to find older sessions. You can also choose transcript files.</p>}
      </> : <div className="file-drop" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void readFiles(event.dataTransfer.files); }}>
        <FileArrowUp size={40} weight="light" aria-hidden="true" /><h3>Bring in saved conversations</h3><p>JSON, JSONL, and text exports from coding agents. Each file can be up to 8 MB.</p><Button onClick={chooseFiles}>Choose files</Button>
        <input ref={input} className="sr-only" tabIndex={-1} aria-label="Transcript files" type="file" accept=".json,.jsonl,.txt,.md" multiple onChange={event => void readFiles(event.target.files)} />
        {files.length > 0 && <ul className="chosen-files">{files.map(file => <li key={file.name}><Check size={16} aria-hidden="true" />{file.name}</li>)}</ul>}
      </div>}
      <p className="field-hint">Only selected sessions are imported. Common credential patterns are redacted, but review transcripts before sharing their context.</p>
      {error && <ErrorNotice message={error} />}
    </div>
    <div className="modal-footer"><span className="muted text-sm">{selectionCount(mode, selected, files)} selected</span><Button variant="primary" busy={busy} disabled={!selectionCount(mode, selected, files)} onClick={importSelected}>Import selected sessions</Button></div>
  </Dialog>;
}

function selectionCount(mode: 'discover' | 'files', selected: Set<string>, files: ImportFile[]) { return mode === 'discover' ? selected.size : files.length; }
