'use client';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUp, Copy, Check, Stop, ArrowSquareOut, CaretRight, Terminal, Code } from '@phosphor-icons/react';
import type { Consultation, Evidence, RunEvent, Specialist } from '@/core/types';
import { api, Badge, Button, counted, ErrorNotice, requestBody, sourceNames } from './ui';
import { ContextMark } from './network-map';
export function ConsultationPanel({ specialist, initialRun, onRun, onSource }: { specialist: Specialist; initialRun?: Consultation; onRun: (run: Consultation) => void; onSource: (id: string, ordinal: number) => void }) {
  const [question, setQuestion] = useState(''); const [mode, setMode] = useState<'answer' | 'context'>('answer');
  const [run, setRun] = useState<Consultation | undefined>(initialRun); const [events, setEvents] = useState<RunEvent[]>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [copied, setCopied] = useState(false);
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const active = run?.status === 'running' || run?.status === 'queued';
  const runId = run?.id;
  useEffect(() => {
    if (!runId || !active) return;
    const controller = new AbortController();
    async function poll() {
      try {
        const data = await api<{ consultation: Consultation; events: RunEvent[] }>(`/api/consultations/${runId}`, { signal: controller.signal });
        setRun(data.consultation); setEvents(data.events);
        if (!['queued', 'running'].includes(data.consultation.status)) onRun(data.consultation);
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Lost the connection. Reopen this consultation to check its state.'); }
    }
    void poll(); const timer = setInterval(() => void poll(), 1000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [runId, active, onRun]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(''); setBusy(true); setCopied(false);
    try {
      const next = await api<Consultation>('/api/consultations', requestBody({ specialistId: specialist.id, question, mode }));
      setRun(next); setEvents([]); setQuestion(''); onRun(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start the consultation. Try again.'); }
    finally { setBusy(false); }
  }
  async function stop() {
    if (!run) return;
    try { const next = await api<Consultation>(`/api/consultations/${run.id}`, { method: 'DELETE' }); setRun(next); onRun(next); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not stop the run. Try again.'); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(run?.answer ?? ''); setCopied(true); }
    catch { setError('Could not copy the answer. Select the text and copy it manually.'); }
  }
  return <section className="consultation-panel" aria-label="Specialist consultation">
    <div className="consultation-content">
      <ConsultationResult run={run} specialist={specialist} events={events} active={active} copied={copied} onCopy={copy} onSource={onSource} onSuggestedQuestion={() => { setQuestion('What decisions were made, and what still needs verification?'); questionInput.current?.focus(); }} />
    </div>
    <form className="composer" onSubmit={submit}>
      <label className="composer-label" htmlFor="specialist-question">Your question</label><textarea ref={questionInput} id="specialist-question" value={question} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="What did we decide?" rows={3} minLength={3} maxLength={4000} required disabled={active} />
      <div className="composer-controls"><label className="mode-select"><span className="sr-only">Consultation mode</span><select value={mode} onChange={event => setMode(event.target.value as 'answer' | 'context')} disabled={active}><option value="answer">Answer</option><option value="context">Handoff</option></select>{mode === 'context' ? <Code size={16} aria-hidden="true" /> : <Terminal size={16} aria-hidden="true" />}</label><span className="composer-shortcut">⌘ Enter</span>{active ? <Button variant="danger" type="button" onClick={stop}><Stop size={16} weight="fill" aria-hidden="true" />Stop run</Button> : <Button variant="primary" type="submit" busy={busy} disabled={specialist.archived}><ArrowUp size={18} aria-hidden="true" />{mode === 'context' ? 'Handoff' : 'Ask'}</Button>}</div>
      <details className="composer-info"><summary>{mode === 'context' ? <><Code size={16} aria-hidden="true" />No model</> : <><Terminal size={16} aria-hidden="true" />{sourceNames[specialist.cli]}</>}</summary><p className="field-hint">{mode === 'context' ? 'Returns a bounded brief and source bundle for another agent. No model is called.' : `Uses your ${sourceNames[specialist.cli]} CLI login. Saved context is historical; review sources before acting.`}</p></details>
      {error && <ErrorNotice message={error} />}
    </form>
  </section>;
}
function RunBadge({ run }: { run: Consultation }) {
  return <Badge active={run.status === 'completed'}>{run.mode === 'context' && run.status === 'completed' ? 'Context ready' : run.status === 'completed' ? 'Answered' : run.status}</Badge>;
}
function AnswerText({ text, evidence, onSource }: { text: string; evidence: Evidence[]; onSource: (id: string, ordinal: number) => void }) {
  const linked = text.replace(/\[(\d+)\]/g, (match, value: string) => Number(value) <= evidence.length ? `[${value}](#evidence-${value})` : match);
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']} components={{ a: ({ href, children }) => {
    const index = href?.match(/^#evidence-(\d+)$/)?.[1]; const item = index ? evidence[Number(index) - 1] : undefined;
    if (item) return <button className="citation-link" onClick={() => onSource(item.sessionId, item.ordinal)} aria-label={`Read source ${index}`}>{children}</button>;
    if (href?.startsWith('https://') || href?.startsWith('http://')) return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
    return <span>{children}</span>;
  } }}>{linked}</ReactMarkdown>;
}
function EvidenceList({ evidence, onSource }: { evidence: Evidence[]; onSource: (id: string, ordinal: number) => void }) {
  return <details className="evidence-list"><summary>{counted(evidence.length, 'source excerpt')} <CaretRight size={14} aria-hidden="true" /></summary><div>{evidence.map((item, index) => <button key={item.id} className="evidence-item" onClick={() => onSource(item.sessionId, item.ordinal)}><span className="evidence-number">[{index + 1}]</span><span><strong>{item.sessionTitle}</strong><span className="muted text-sm">{sourceNames[item.source]}, message {item.ordinal + 1}</span><q>{item.quote}</q></span><ArrowSquareOut size={16} aria-hidden="true" /></button>)}</div></details>;
}

function ConsultationResult({ run, specialist, events, active, copied, onCopy, onSource, onSuggestedQuestion }: { run?: Consultation; specialist: Specialist; events: RunEvent[]; active: boolean; copied: boolean; onCopy: () => void; onSource: (id: string, ordinal: number) => void; onSuggestedQuestion: () => void }) {
  return run ? <><div className="question-bubble"><span className="message-speaker">You asked</span><p dir="auto">{run.question}</p></div>
        <div className="specialist-answer"><div className="answer-heading"><span className="message-speaker"><ContextMark size={20} />{specialist.name}</span><RunBadge run={run} /></div>
          {active && <div className="run-progress" role="status"><span className="run-pulse" aria-hidden="true" /><p>{run.status === 'queued' ? 'Waiting for a specialist slot…' : `${sourceNames[run.cli]} is answering from the saved context…`}</p></div>}
          {run.status === 'completed' && <CompletedAnswer run={run} copied={copied} onCopy={onCopy} onSource={onSource} />}
          {run.status === 'failed' && <ErrorNotice message={run.error ?? 'The agent did not return an answer. Check its CLI login in Connections and try again.'} />}
          {run.status === 'cancelled' && <p className="muted">This consultation was stopped. Ask again to start a fresh run.</p>}
          {run.evidence.length > 0 && <EvidenceList evidence={run.evidence} onSource={onSource} />}
          <details className="run-details"><summary><Terminal size={16} aria-hidden="true" />Inspect this run <CaretRight size={14} aria-hidden="true" /></summary><dl><dt>Agent</dt><dd>{run.mode === 'context' ? 'Context handoff, no agent call' : sourceNames[run.cli]}</dd><dt>Context sent</dt><dd>{run.context.length.toLocaleString()} characters</dd><dt>Saved brief</dt><dd>Revision {run.briefRevision}</dd><dt>Elapsed</dt><dd>{run.durationMs === null ? 'Not recorded' : `${(run.durationMs / 1000).toFixed(1)} seconds`}</dd></dl>{events.map(event => <p className="run-event" key={event.id}>{event.text}</p>)}<details><summary>Read the full context packet</summary><pre className="context-preview" tabIndex={0} aria-label="Full context packet">{run.context}</pre></details></details>
        </div>
      </> : <div className="consultation-empty"><h3>Ask</h3><Button variant="ghost" aria-label="Ask about decisions and open questions" onClick={onSuggestedQuestion}>Decisions <ArrowSquareOut size={16} aria-hidden="true" /></Button></div>;
}

function CompletedAnswer({ run, copied, onCopy, onSource }: { run: Consultation; copied: boolean; onCopy: () => void; onSource: (id: string, ordinal: number) => void }) {
  return <><div dir="auto" className={`answer-content ${run.mode === 'context' ? 'context-answer' : ''}`}>{run.mode === 'context' ? <pre tabIndex={0} aria-label="Context handoff">{run.answer}</pre> : <AnswerText text={run.answer} evidence={run.evidence} onSource={onSource} />}</div><div className="answer-actions"><Button variant="ghost" aria-label={copied ? 'Copied' : run.mode === 'context' ? 'Copy context handoff' : 'Copy answer'} onClick={onCopy}>{copied ? <Check aria-hidden="true" size={16} /> : <Copy aria-hidden="true" size={16} />}{copied ? 'Copied' : 'Copy'}</Button></div></>;
}
