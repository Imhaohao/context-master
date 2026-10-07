'use client';
import { Stack, ArrowRight } from '@phosphor-icons/react';
import type { Session, Specialist } from '@/core/types';

export function ContextMark({ size = 32, className = '' }: { size?: number; className?: string }) {
  return <svg className={`context-mark ${className}`} width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <path d="M3 4H9L21 16H29M3 12H13L21 16M3 20H13L21 16M3 28H9L21 16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="m21 12 4 4-4 4-4-4Z" fill="currentColor" />
  </svg>;
}

function ConvergingPaths({ count }: { count: number }) {
  return <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="network-wires" aria-hidden="true">
    {Array.from({ length: count }, (_, index) => {
      const center = ((index + 0.5) / count) * 100;
      return <path key={index} d={`M0 ${center} H12 C55 ${center}, 45 50, 85 50 H100`} />;
    })}
    <path className="network-wire-active" d="M85 50H100" />
  </svg>;
}

export function NetworkMap({ specialist, sessions, onSession }: { specialist: Specialist; sessions: Session[]; onSession: (id: string) => void }) {
  const linked = sessions.filter(session => specialist.sessionIds.includes(session.id));
  const shown = linked.slice(0, 5);
  return <div className="context-provenance">
    <div className="network-map" role="group" aria-label={`${linked.length} source sessions feed ${specialist.name}`}>
      <div className="context-inputs network-sources">{shown.map(session => <button key={session.id} onClick={() => onSession(session.id)} title={session.title}><Stack aria-hidden="true" size={18} /><span>{session.title}</span><ArrowRight aria-hidden="true" size={14} /></button>)}</div>
      <div className="network-routing"><ConvergingPaths count={shown.length} /></div>
      <div className="network-specialist"><ContextMark size={40} /><span>Brief</span><span className="network-caption">Revision {specialist.revision}</span></div>
    </div>
    {linked.length > shown.length && <p className="field-hint">Showing {shown.length} of {linked.length} linked sessions. Open Sources to see all of them.</p>}
  </div>;
}

export function LibraryIllustration() {
  return <div className="library-illustration" aria-hidden="true">
    <div className="context-inputs">{['Codex', 'Claude Code', 'OpenCode', 'Cursor'].map(name => <div className="illustration-session" key={name}><Stack size={18} /><span>{name}</span></div>)}</div>
    <div className="network-routing"><ConvergingPaths count={4} /></div>
    <div className="illustration-specialist"><ContextMark size={64} /><span>Your specialist</span></div>
  </div>;
}
