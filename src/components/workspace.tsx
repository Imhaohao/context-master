'use client';
import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Archive, CaretRight, Clock, FileText, Graph, DownloadSimple, MagnifyingGlass, PencilSimple, PlugsConnected, Plus, Stack, Terminal, X } from '@phosphor-icons/react';
import type { Consultation, Library, Match, Session, Specialist } from '@/core/types';
import { api, Badge, Button, counted, Dialog, EmptyState, ErrorNotice, IconButton, relativeTime, requestBody, sourceNames } from './ui';
import { useAppearance } from './appearance';
import { ImportDialog } from './import-dialog';
import { SpecialistEditor } from './specialist-editor';
import { SessionsPanel, SessionView } from './session-view';
import { ConnectionsPanel } from './connections';
import { ConsultationPanel } from './consultation';
import { LibraryIllustration, NetworkMap } from './network-map';
type View = 'specialists' | 'sessions' | 'activity' | 'connections';
type Draft = Pick<Specialist, 'name' | 'description' | 'brief' | 'tags'>;
interface EditorState { initial: Draft; sessionIds: string[]; specialist?: Specialist }
const views: { id: View; label: string; icon: typeof Graph }[] = [
  { id: 'specialists', label: 'Specialists', icon: Graph }, { id: 'sessions', label: 'Sessions', icon: Stack },
  { id: 'activity', label: 'Activity', icon: Clock }, { id: 'connections', label: 'Connections', icon: PlugsConnected }
];
export function Workspace() {
  useAppearance();
  const [library, setLibrary] = useState<Library | null>(null); const [view, setView] = useState<View>('specialists');
  const [specialistId, setSpecialistId] = useState(''); const [runId, setRunId] = useState('');
  const [importOpen, setImportOpen] = useState(false); const [editor, setEditor] = useState<EditorState | null>(null);
  const [source, setSource] = useState<{ id: string; ordinal?: number } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => { try { setLibrary(await api<Library>('/api/library')); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open the local library. Restart the app.'); } }, []);
  useEffect(() => { const controller = new AbortController(); api<Library>('/api/library', { signal: controller.signal }).then(setLibrary).catch(cause => { if (!controller.signal.aborted) setError(cause.message); }); return () => controller.abort(); }, []);
  useEffect(() => {
    const update = () => { if (document.visibilityState === 'visible') void refresh(); };
    const timer = setInterval(update, 5000);
    window.addEventListener('focus', update);
    return () => { clearInterval(timer); window.removeEventListener('focus', update); };
  }, [refresh]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (document.querySelector('dialog[open]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(true); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') { event.preventDefault(); setImportOpen(true); }
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  const onRun = useCallback((run: Consultation) => {
    setRunId(run.id);
    setLibrary(previous => previous ? { ...previous, consultations: [run, ...previous.consultations.filter(item => item.id !== run.id)] } : previous);
  }, []);
  async function create(ids: string[]) {
    setBusy(true); setError(''); setImportOpen(false); setSource(null);
    try { const initial = await api<Draft>('/api/specialists', requestBody({ action: 'draft', sessionIds: ids })); await refresh(); setEditor({ initial, sessionIds: ids }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not draft the specialist. Try again.'); }
    finally { setBusy(false); }
  }
  async function examples() {
    setBusy(true); setError('');
    try { await api('/api/demo', { method: 'POST' }); await refresh(); setNotice('Example specialists added. Their sessions are synthetic and marked “example”.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load the example library.'); }
    finally { setBusy(false); }
  }
  async function save(specialist: Specialist) { setEditor(null); setSpecialistId(specialist.id); setView('specialists'); setRunId(''); await refresh(); setNotice(`${specialist.name} saved.`); }
  function select(id: string) { setSpecialistId(id); setRunId(''); setView('specialists'); }
  function openRun(run: Consultation) { setSpecialistId(run.specialistId); setRunId(run.id); setView('specialists'); }
  const active = chooseSpecialist(library, specialistId);
  const currentRun = chooseRun(library, runId, active);
  const label = views.find(item => item.id === view)?.label ?? 'Specialists';
  return <div className="app-shell">
    <a href="#main-content" className="skip-link">Skip to workspace</a>
    <Sidebar library={library} view={view} onView={setView} onSearch={() => setSearchOpen(true)} onOpenRun={openRun} />
    <div className="main-shell"><header className="topbar"><div className="breadcrumbs"><span>Library</span><CaretRight aria-hidden="true" size={14} /><strong>{label}</strong></div><div className="topbar-actions"><span className="local-pill"><span className="state-dot state-completed" aria-hidden="true" />Local</span><Button onClick={() => setImportOpen(true)} busy={busy}><DownloadSimple size={16} aria-hidden="true" />Import sessions</Button></div></header>
      <main id="main-content" className={`workspace-main ${view === 'specialists' ? 'workspace-specialists' : ''}`}>
        <div className="page-heading"><div><h1>{label}</h1><p>{viewDescription(view, library)}</p></div>{view === 'specialists' && library?.sessions.length ? <Button variant="primary" onClick={() => setView('sessions')}><Plus size={16} aria-hidden="true" />Create specialist</Button> : null}</div>
        <div className="live-status" role="status">{notice && <span>{notice}<IconButton label="Dismiss notification" onClick={() => setNotice('')}><CheckSmall /></IconButton></span>}</div>
        {error && <div className="workspace-error"><ErrorNotice message={error} /><Button variant="ghost" onClick={() => { setError(''); void refresh(); }}>Reload library</Button></div>}
        {!library ? <div className="loading-state" role="status">Opening your local library…</div> : <ActiveView view={view} library={library} active={active} currentRun={currentRun} onImport={() => setImportOpen(true)} onExamples={examples} busy={busy} onSelect={select} onEdit={specialist => setEditor({ initial: specialist, sessionIds: specialist.sessionIds, specialist })} onRefresh={refresh} onCreate={ids => void create(ids)} onSource={(id, ordinal) => setSource({ id, ordinal })} onRun={onRun} onOpenRun={openRun} />}
      </main>
    </div>
    {importOpen && <ImportDialog onClose={() => { setImportOpen(false); void refresh(); }} onImported={ids => void create(ids)} />}
    {editor && library && <SpecialistEditor {...editor} sessions={library.sessions} onClose={() => setEditor(null)} onSaved={specialist => void save(specialist)} />}
    {source && <SessionView sessionId={source.id} highlight={source.ordinal} onClose={() => setSource(null)} onCreate={ids => void create(ids)} onDeleted={() => { setSource(null); void refresh(); }} />}
    {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} onSelect={id => { select(id); setSearchOpen(false); }} />}
  </div>;
}
function CheckSmall() { return <X size={16} aria-hidden="true" />; }
function viewDescription(view: View, library: Library | null) {
  const descriptions = { specialists: `${counted(library?.specialists.filter(item => !item.archived).length ?? 0, 'specialist')} built from saved work.`, sessions: 'Original conversations provide the evidence behind each specialist.', activity: 'Inspect questions, answers, and the context each agent received.', connections: 'Use your subscriptions and make this library available to other agents.' };
  return descriptions[view];
}
interface ViewProps {
  view: View; library: Library; active?: Specialist; currentRun?: Consultation; onImport: () => void;
  onExamples: () => void; busy: boolean; onSelect: (id: string) => void; onEdit: (specialist: Specialist) => void;
  onRefresh: () => Promise<void>; onCreate: (ids: string[]) => void; onSource: (id: string, ordinal?: number) => void;
  onRun: (run: Consultation) => void; onOpenRun: (run: Consultation) => void;
}
function ActiveView(props: ViewProps) {
  switch (props.view) {
    case 'sessions': return <SessionsPanel sessions={props.library.sessions} onImport={props.onImport} onSelect={props.onSource} onCreate={props.onCreate} />;
    case 'activity': return <ActivityPanel runs={props.library.consultations} onOpen={props.onOpenRun} />;
    case 'connections': return <ConnectionsPanel />;
    default: return <SpecialistsPanel {...props} />;
  }
}
function SpecialistsPanel({ library, active, currentRun, onImport, onExamples, busy, onSelect, onEdit, onRefresh, onSource, onRun }: ViewProps) {
  const [query, setQuery] = useState(''); const [archived, setArchived] = useState(false);
  const visible = library.specialists.filter(item => item.archived === archived && `${item.name} ${item.description} ${item.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  if (!library.specialists.length) return <div className="library-empty"><LibraryIllustration /><h2>Build your specialist library</h2><p>Import a coding session, keep its useful context, and let another agent ask it a question.</p><div className="empty-actions"><Button variant="primary" onClick={onImport}><DownloadSimple aria-hidden="true" size={18} />Import sessions</Button><Button busy={busy} onClick={onExamples}>Try the example library <ArrowRight size={16} aria-hidden="true" /></Button></div><div className="supported-agents"><span>Codex</span><span>Claude Code</span><span>OpenCode</span><span>Cursor</span><span>Transcript exports</span></div></div>;
  return <div className="specialist-workbench"><div className="specialist-index"><label className="search-input"><MagnifyingGlass size={17} aria-hidden="true" /><span className="sr-only">Filter specialists</span><input placeholder="Filter specialists" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="index-filter"><button aria-pressed={!archived} onClick={() => setArchived(false)}>Available</button><button aria-pressed={archived} onClick={() => setArchived(true)}>Archived</button></div><div className="specialist-list">{visible.map(specialist => <button key={specialist.id} onClick={() => onSelect(specialist.id)} aria-pressed={active?.id === specialist.id} className={`specialist-row ${active?.id === specialist.id ? 'is-selected' : ''}`}><div className="specialist-row-title"><Graph aria-hidden="true" size={20} weight="light" /><strong>{specialist.name}</strong>{active?.id === specialist.id && <CaretRight size={16} aria-hidden="true" />}</div><p>{specialist.description}</p><div className="specialist-row-meta"><span>{sourceNames[specialist.cli]}</span><span>{counted(specialist.sessionIds.length, 'source')}</span></div>{specialist.tags.includes('example') && <Badge>Example</Badge>}</button>)}</div>{!visible.length && <p className="loading-state">No {archived ? 'archived' : 'available'} specialists match.</p>}</div>
    {active ? <SpecialistDetail key={`${active.id}-${currentRun?.id ?? 'new'}`} specialist={active} sessions={library.sessions} run={currentRun} onEdit={() => onEdit(active)} onRefresh={onRefresh} onSource={onSource} onRun={onRun} /> : <EmptyState icon={<Graph size={44} weight="light" />} title="Choose a specialist"><p>Restore an archived specialist or create one from a saved session.</p></EmptyState>}
  </div>;
}
function SpecialistDetail({ specialist, sessions, run, onEdit, onRefresh, onSource, onRun }: { specialist: Specialist; sessions: Session[]; run?: Consultation; onEdit: () => void; onRefresh: () => Promise<void>; onSource: (id: string, ordinal?: number) => void; onRun: (run: Consultation) => void }) {
  const [tab, setTab] = useState<'ask' | 'context' | 'sources'>('ask'); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function archive() { setBusy(true); try { await api(`/api/specialists/${specialist.id}`, { method: 'PATCH', body: JSON.stringify({ archived: !specialist.archived }) }); await onRefresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not change the specialist state.'); } finally { setBusy(false); } }
  const reduction = specialist.sourceCharacters > 0 ? Math.max(0, Math.round((1 - specialist.brief.length / specialist.sourceCharacters) * 100)) : 0;
  return <div className="specialist-detail"><div className="detail-heading"><div className="detail-title"><Graph aria-hidden="true" size={32} weight="light" /><div><h2>{specialist.name}</h2><span className="text-sm muted">{sourceNames[specialist.cli]} answers from revision {specialist.revision}</span></div></div><IconButton label="Edit specialist" onClick={onEdit}><PencilSimple size={18} aria-hidden="true" /></IconButton></div><p className="detail-description">{specialist.description}</p>
    <div className="detail-tabs" role="group" aria-label="Specialist views"><button aria-pressed={tab === 'ask'} onClick={() => setTab('ask')}>Ask specialist</button><button aria-pressed={tab === 'context'} onClick={() => setTab('context')}>Read saved context</button><button aria-pressed={tab === 'sources'} onClick={() => setTab('sources')}>Browse sources <span>{specialist.sessionIds.length}</span></button></div>
    {specialist.archived && <div className="archived-notice"><Archive size={18} aria-hidden="true" /><span>This specialist is archived.</span><Button variant="ghost" busy={busy} onClick={archive}>Restore specialist</Button></div>}
    {tab === 'ask' && <ConsultationPanel specialist={specialist} initialRun={run} onRun={onRun} onSource={onSource} />}
    {tab === 'context' && <div className="detail-tab-content"><NetworkMap specialist={specialist} sessions={sessions} onSession={onSource} /><div className="brief-budget"><span>{specialist.brief.length.toLocaleString()} characters saved</span><span>{reduction > 0 ? `${reduction}% smaller than source text` : 'Brief includes source excerpts'}</span></div><div className="brief-text">{specialist.brief}</div><div className="brief-footer"><span className="muted text-sm">Saved {relativeTime(specialist.updatedAt)}</span><Button onClick={onEdit}>Edit context</Button></div></div>}
    {tab === 'sources' && <div className="detail-tab-content"><NetworkMap specialist={specialist} sessions={sessions} onSession={onSource} />{sessions.filter(session => specialist.sessionIds.includes(session.id)).map(session => <button className="linked-source" key={session.id} onClick={() => onSource(session.id)}><FileText size={24} aria-hidden="true" weight="light" /><span><strong>{session.title}</strong><span className="muted text-sm">{sourceNames[session.source]}, {counted(session.messageCount, 'message')}</span></span><CaretRight size={18} aria-hidden="true" /></button>)}</div>}
    <div className="detail-bottom"><div className="tag-list">{specialist.tags.map(tag => <Badge key={tag}>{tag}</Badge>)}</div>{!specialist.archived && <Button variant="ghost" busy={busy} onClick={archive}><Archive size={16} aria-hidden="true" />Archive</Button>}{error && <ErrorNotice message={error} />}</div>
  </div>;
}
function ActivityPanel({ runs, onOpen }: { runs: Consultation[]; onOpen: (run: Consultation) => void }) {
  if (!runs.length) return <EmptyState icon={<Clock size={44} weight="light" />} title="No consultations yet"><p>Ask a specialist a question. Its context and result will appear here.</p></EmptyState>;
  return <div className="panel-content activity-panel">{runs.map(run => <button className="activity-row" key={run.id} onClick={() => onOpen(run)}><span className={`state-dot state-${run.status}`} aria-hidden="true" /><div><strong>{run.question}</strong><span className="muted text-sm">{run.specialistName}</span></div><div className="activity-state"><Badge active={run.status === 'completed'}>{run.status}</Badge><span className="muted text-sm">{relativeTime(run.createdAt)}</span></div><CaretRight size={18} aria-hidden="true" /></button>)}</div>;
}
function SearchDialog({ onClose, onSelect }: { onClose: () => void; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState(''); const [matches, setMatches] = useState<Match[]>([]); const [error, setError] = useState('');
  useEffect(() => { const controller = new AbortController(); const timer = setTimeout(() => { api<Match[]>(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal }).then(setMatches).catch(cause => { if (!controller.signal.aborted) setError(cause.message); }); }, 150); return () => { clearTimeout(timer); controller.abort(); }; }, [query]);
  return <Dialog title="Find a specialist" onClose={onClose}><div className="modal-body stack"><label className="search-input"><MagnifyingGlass size={20} aria-hidden="true" /><span className="sr-only">Question or topic</span><input autoFocus placeholder="What do you need help with?" value={query} onChange={event => setQuery(event.target.value)} maxLength={4000} /></label><div className="command-results">{matches.map(match => <button key={match.specialist.id} onClick={() => onSelect(match.specialist.id)}><Graph size={22} aria-hidden="true" weight="light" /><span><strong>{match.specialist.name}</strong><span className="muted text-sm">{match.reasons.length ? `Matches ${match.reasons.join(', ')}` : match.specialist.description}</span></span><ArrowRight size={16} aria-hidden="true" /></button>)}</div>{!matches.length && <p className="muted">No specialists match yet. Import a session or try a term from your saved work.</p>}{error && <ErrorNotice message={error} />}</div></Dialog>;
}

function Sidebar({ library, view, onView, onSearch, onOpenRun }: { library: Library | null; view: View; onView: (view: View) => void; onSearch: () => void; onOpenRun: (run: Consultation) => void }) {
  return (    <aside className="sidebar"><div className="window-space" aria-hidden="true" /><div className="brand"><Graph weight="light" size={28} aria-hidden="true" /><span>Context Master</span></div>
      <button className="global-search" onClick={onSearch}><MagnifyingGlass aria-hidden="true" size={18} /><span>Find a specialist</span><kbd>⌘ K</kbd></button>
      <nav aria-label="Workspace">{views.map(item => <button key={item.id} className={`nav-item ${view === item.id ? 'nav-selected' : ''}`} aria-label={item.label} aria-current={view === item.id ? 'page' : undefined} onClick={() => onView(item.id)}><item.icon size={20} aria-hidden="true" weight={view === item.id ? 'fill' : 'regular'} /><span>{item.label}</span>{item.id === 'specialists' && library && <span className="nav-count">{library.specialists.filter(specialist => !specialist.archived).length}</span>}</button>)}</nav>
      <div className="sidebar-recents"><span className="sidebar-label">Recently used</span>{library?.consultations.slice(0, 5).map(run => <button key={run.id} onClick={() => onOpenRun(run)}><span className={`state-dot state-${run.status}`} aria-hidden="true" /><span>{run.specialistName}</span></button>)}</div>
      <div className="sidebar-bottom"><span className="local-status"><span className="state-dot state-completed" aria-hidden="true" />On this Mac</span><p>Sessions stay in your local library.</p><Button variant="ghost" onClick={() => onView('connections')}><Terminal size={16} aria-hidden="true" />Connect your agents</Button></div>
    </aside>);
}
function chooseSpecialist(library: Library | null, id: string) { return library?.specialists.find(item => item.id === id) ?? library?.specialists.find(item => !item.archived); }
function chooseRun(library: Library | null, id: string, specialist?: Specialist) { return library?.consultations.find(item => item.id === id && item.specialistId === specialist?.id) ?? library?.consultations.find(item => item.specialistId === specialist?.id); }
