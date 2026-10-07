'use client';
import { useCallback, useEffect, useId, useState } from 'react';
import { ArrowRight, Archive, CaretRight, Clock, CaretDown, FileText, Graph, DownloadSimple, MagnifyingGlass, PencilSimple, PlugsConnected, Plus, Stack, ChatCircle, X } from '@phosphor-icons/react';
import type { Consultation, Library, Match, Session, Specialist } from '@/core/types';
import { api, Badge, Button, counted, Dialog, EmptyState, ErrorNotice, IconButton, relativeTime, requestBody, sourceNames } from './ui';
import { useAppearance } from './appearance';
import { ImportDialog } from './import-dialog';
import { SpecialistEditor } from './specialist-editor';
import { SessionsPanel, SessionView } from './session-view';
import { ConnectionsPanel } from './connections';
import { ConsultationPanel } from './consultation';
import { ContextMark, LibraryIllustration, NetworkMap } from './network-map';
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
    <Sidebar view={view} onView={setView} onSearch={() => setSearchOpen(true)} />
    <div className="main-shell"><WorkspaceHeader view={view} label={label} library={library} busy={busy} onSearch={() => setSearchOpen(true)} onCreate={() => setView('sessions')} onImport={() => setImportOpen(true)} />
      <main id="main-content" tabIndex={-1} className={`workspace-main ${view === 'specialists' ? 'workspace-specialists' : ''}`}>
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
function WorkspaceHeader({ view, label, library, busy, onSearch, onCreate, onImport }: { view: View; label: string; library: Library | null; busy: boolean; onSearch: () => void; onCreate: () => void; onImport: () => void }) {
  return <header className="topbar"><h1 className={view === 'specialists' && library?.specialists.length ? 'sr-only' : ''}>{label}</h1><div className="topbar-actions"><IconButton className="mobile-search" label="Find a specialist" onClick={onSearch}><MagnifyingGlass size={20} aria-hidden="true" /></IconButton>{view === 'specialists' && Boolean(library?.sessions.length) && <Button variant="ghost" onClick={onCreate}><Plus size={18} aria-hidden="true" />Create</Button>}<Button aria-label="Import sessions" onClick={onImport} busy={busy}><DownloadSimple size={18} aria-hidden="true" />Import</Button></div></header>;
}
function CheckSmall() { return <X size={16} aria-hidden="true" />; }
interface ViewProps {
  view: View; library: Library; active?: Specialist; currentRun?: Consultation; onImport: () => void;
  onExamples: () => void; busy: boolean; onSelect: (id: string) => void; onEdit: (specialist: Specialist) => void;
  onRefresh: () => Promise<void>; onCreate: (ids: string[]) => void; onSource: (id: string, ordinal?: number) => void;
  onRun: (run: Consultation) => void; onOpenRun: (run: Consultation) => void;
}
function ActiveView(props: ViewProps) {
  switch (props.view) {
    case 'sessions': return <SessionsPanel sessions={props.library.sessions} onImport={props.onImport} onSelect={props.onSource} onCreate={props.onCreate} />;
    case 'activity': return <ActivityPanel runs={props.library.consultations} onOpen={props.onOpenRun} onAsk={() => props.onSelect(props.library.specialists.find(item => !item.archived)?.id ?? '')} />;
    case 'connections': return <ConnectionsPanel />;
    default: return <SpecialistsPanel {...props} />;
  }
}
function SpecialistsPanel({ library, active, currentRun, onImport, onExamples, busy, onSelect, onEdit, onRefresh, onSource, onRun }: ViewProps) {
  const [query, setQuery] = useState(''); const [archived, setArchived] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false); const indexId = useId();
  const visible = library.specialists.filter(item => item.archived === archived && `${item.name} ${item.description} ${item.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  if (!library.specialists.length) return <div className="library-empty"><LibraryIllustration /><h2>Ask your past work</h2><p>Turn saved agent sessions into specialists.</p><div className="empty-actions"><Button variant="primary" aria-label="Import sessions" onClick={onImport}><DownloadSimple aria-hidden="true" size={18} />Import</Button><Button busy={busy} onClick={onExamples}>Try examples <ArrowRight size={16} aria-hidden="true" /></Button></div></div>;
  return <div className="specialist-workbench"><div className="specialist-picker"><Button className="mobile-picker-toggle" aria-expanded={pickerOpen} aria-controls={indexId} onClick={() => setPickerOpen(!pickerOpen)}>Change specialist <CaretDown size={16} aria-hidden="true" /></Button><div id={indexId} className={`specialist-index ${pickerOpen ? 'picker-open' : ''}`}><h2 className="index-heading">Specialists</h2><label className="search-input"><MagnifyingGlass size={17} aria-hidden="true" /><span className="sr-only">Filter specialists</span><input placeholder="Filter specialists" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="index-filter"><button aria-pressed={!archived} onClick={() => setArchived(false)}>Available</button><button aria-pressed={archived} onClick={() => setArchived(true)}>Archived</button></div><div className="specialist-list">{visible.map(specialist => <button key={specialist.id} onClick={() => { onSelect(specialist.id); setPickerOpen(false); }} aria-pressed={active?.id === specialist.id} className={`specialist-row ${active?.id === specialist.id ? 'is-selected' : ''}`}><div className="specialist-row-title"><strong>{specialist.name}</strong>{active?.id === specialist.id && <CaretRight size={16} aria-hidden="true" />}</div>{specialist.tags.includes('example') && <span className="text-sm muted">Example</span>}</button>)}</div>{!visible.length && <p className="loading-state">No {archived ? 'archived' : 'available'} specialists match.</p>}</div></div>
    {active ? <SpecialistDetail key={`${active.id}-${currentRun?.id ?? 'new'}`} specialist={active} sessions={library.sessions} run={currentRun} onEdit={() => onEdit(active)} onRefresh={onRefresh} onSource={onSource} onRun={onRun} /> : <EmptyState icon={<Graph size={44} weight="light" />} title="Choose a specialist"><p>Restore an archived specialist or create one from a saved session.</p></EmptyState>}
  </div>;
}
function SpecialistDetail({ specialist, sessions, run, onEdit, onRefresh, onSource, onRun }: { specialist: Specialist; sessions: Session[]; run?: Consultation; onEdit: () => void; onRefresh: () => Promise<void>; onSource: (id: string, ordinal?: number) => void; onRun: (run: Consultation) => void }) {
  const [tab, setTab] = useState<'ask' | 'context' | 'sources'>('ask'); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function archive() { setBusy(true); try { await api(`/api/specialists/${specialist.id}`, { method: 'PATCH', body: JSON.stringify({ archived: !specialist.archived }) }); await onRefresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not change the specialist state.'); } finally { setBusy(false); } }
  const panelId = useId();
  const linked = sessions.filter(session => specialist.sessionIds.includes(session.id));
  const tabs = [{ id: 'ask', label: 'Ask', icon: ChatCircle }, { id: 'context', label: 'Brief', icon: Graph }, { id: 'sources', label: 'Sources', icon: Stack }] as const;
  function moveTab(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const positions: Record<string, number> = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 };
    const next = positions[event.key];
    if (next === undefined) return;
    event.preventDefault(); setTab(tabs[next].id); document.getElementById(`${panelId}-tab-${tabs[next].id}`)?.focus();
  }
  return <div className="specialist-detail"><div className="detail-heading"><div className="detail-title"><ContextMark size={32} /><h2 dir="auto">{specialist.name}</h2></div><IconButton label="Edit specialist" onClick={onEdit}><PencilSimple size={18} aria-hidden="true" /></IconButton></div>
    <div className="detail-tabs" role="tablist" aria-label="Specialist views">{tabs.map((item, index) => <button key={item.id} id={`${panelId}-tab-${item.id}`} role="tab" aria-selected={tab === item.id} aria-controls={`${panelId}-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => moveTab(event, index)}><item.icon size={18} aria-hidden="true" />{item.label}</button>)}</div>
    {specialist.archived && <div className="archived-notice"><Archive size={18} aria-hidden="true" /><span>Archived</span><Button variant="ghost" busy={busy} onClick={archive}>Restore specialist</Button></div>}
    <div role="tabpanel" id={`${panelId}-panel-ask`} aria-labelledby={`${panelId}-tab-ask`} hidden={tab !== 'ask'}><ConsultationPanel specialist={specialist} initialRun={run} onRun={onRun} onSource={onSource} /></div>
    <div role="tabpanel" id={`${panelId}-panel-context`} aria-labelledby={`${panelId}-tab-context`} hidden={tab !== 'context'} tabIndex={0} className="detail-tab-content"><NetworkMap specialist={specialist} sessions={sessions} onSession={onSource} /><div dir="auto" className="brief-text">{specialist.brief}</div><details className="brief-info"><summary>Brief details</summary><p className="muted text-sm">{specialist.description}</p><dl><dt>Revision</dt><dd>{specialist.revision}</dd><dt>Saved</dt><dd>{relativeTime(specialist.updatedAt)}</dd><dt>Brief size</dt><dd>{specialist.brief.length.toLocaleString()} characters</dd><dt>Source size</dt><dd>{specialist.sourceCharacters.toLocaleString()} characters</dd></dl><div className="tag-list">{specialist.tags.map(tag => <Badge key={tag}>{tag}</Badge>)}</div></details><div className="brief-footer"><Button onClick={onEdit}><PencilSimple size={16} aria-hidden="true" />Edit brief</Button>{!specialist.archived && <Button variant="ghost" busy={busy} onClick={archive}><Archive size={16} aria-hidden="true" />Archive</Button>}</div></div>
    <div role="tabpanel" id={`${panelId}-panel-sources`} aria-labelledby={`${panelId}-tab-sources`} hidden={tab !== 'sources'} tabIndex={0} className="detail-tab-content">{linked.map(session => <button className="linked-source" key={session.id} onClick={() => onSource(session.id)}><FileText size={24} aria-hidden="true" weight="light" /><span><strong>{session.title}</strong><span className="muted text-sm">{sourceNames[session.source]}, {counted(session.messageCount, 'message')}</span></span><CaretRight size={18} aria-hidden="true" /></button>)}</div>
    {error && <ErrorNotice message={error} />}
  </div>;
}
function ActivityPanel({ runs, onOpen, onAsk }: { runs: Consultation[]; onOpen: (run: Consultation) => void; onAsk: () => void }) {
  if (!runs.length) return <EmptyState icon={<Clock size={44} weight="light" />} title="No consultations yet"><Button onClick={onAsk}><ChatCircle size={18} aria-hidden="true" />Ask a specialist</Button></EmptyState>;
  return <div className="panel-content activity-panel">{runs.map(run => <button className="activity-row" key={run.id} onClick={() => onOpen(run)}><span className={`state-dot state-${run.status}`} aria-hidden="true" /><div><strong dir="auto">{run.question}</strong><span className="muted text-sm">{run.specialistName}</span></div><div className="activity-state"><Badge active={run.status === 'completed'}>{run.status}</Badge><span className="muted text-sm">{relativeTime(run.createdAt)}</span></div><CaretRight size={18} aria-hidden="true" /></button>)}</div>;
}
function SearchDialog({ onClose, onSelect }: { onClose: () => void; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState(''); const [matches, setMatches] = useState<Match[]>([]); const [error, setError] = useState('');
  useEffect(() => { const controller = new AbortController(); const timer = setTimeout(() => { api<Match[]>(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal }).then(setMatches).catch(cause => { if (!controller.signal.aborted) setError(cause.message); }); }, 150); return () => { clearTimeout(timer); controller.abort(); }; }, [query]);
  return <Dialog title="Find a specialist" onClose={onClose}><div className="modal-body stack"><label className="search-input"><MagnifyingGlass size={20} aria-hidden="true" /><span className="sr-only">Question or topic</span><input autoFocus placeholder="What do you need help with?" value={query} onChange={event => setQuery(event.target.value)} maxLength={4000} /></label><div className="command-results">{matches.map(match => <button key={match.specialist.id} onClick={() => onSelect(match.specialist.id)}><ContextMark size={24} /><span><strong>{match.specialist.name}</strong><span className="muted text-sm">{match.reasons.length ? `Matches ${match.reasons.join(', ')}` : match.specialist.description}</span></span><ArrowRight size={16} aria-hidden="true" /></button>)}</div>{!matches.length && <p className="muted">No specialists match yet. Import a session or try a term from your saved work.</p>}{error && <ErrorNotice message={error} />}</div></Dialog>;
}

function Sidebar({ view, onView, onSearch }: { view: View; onView: (view: View) => void; onSearch: () => void }) {
  return <aside className="sidebar"><div className="window-space" aria-hidden="true" /><div className="brand" role="img" aria-label="Context Master"><ContextMark size={28} /></div><IconButton className="rail-search" label="Find a specialist" onClick={onSearch}><MagnifyingGlass size={21} aria-hidden="true" /></IconButton>
    <nav aria-label="Workspace">{views.map(item => <IconButton key={item.id} className={`nav-item ${view === item.id ? 'nav-selected' : ''}`} label={item.label} aria-current={view === item.id ? 'page' : undefined} onClick={() => onView(item.id)}><item.icon size={22} aria-hidden="true" weight={view === item.id ? 'fill' : 'regular'} /><span className="nav-touch-label" aria-hidden="true">{item.label}</span></IconButton>)}</nav>
  </aside>;
}
function chooseSpecialist(library: Library | null, id: string) { return library?.specialists.find(item => item.id === id) ?? library?.specialists.find(item => !item.archived); }
function chooseRun(library: Library | null, id: string, specialist?: Specialist) { return library?.consultations.find(item => item.id === id && item.specialistId === specialist?.id) ?? library?.consultations.find(item => item.specialistId === specialist?.id); }
