'use client';
import { Graph, ChatCircle, Stack } from '@phosphor-icons/react';
import type { Session, Specialist } from '@/core/types';
export function NetworkMap({ specialist, sessions, onSession }: { specialist: Specialist; sessions: Session[]; onSession: (id: string) => void }) {
  const linked = sessions.filter(session => specialist.sessionIds.includes(session.id)).slice(0, 5);
  return <div className="network-map" aria-label={`${linked.length} source sessions feed ${specialist.name}`}>
    <svg viewBox="0 0 500 180" className="network-wires" aria-hidden="true">{linked.map((session, index) => { const y = ((index + 1) / (linked.length + 1)) * 160 + 10; return <path key={session.id} d={`M 95 ${y} C 180 ${y}, 180 90, 260 90`} />; })}<path className="network-wire-active" d="M 280 90 C 350 90, 350 90, 422 90" /></svg>
    <div className="network-sources">{linked.map(session => <button key={session.id} onClick={() => onSession(session.id)} title={session.title}><Stack aria-hidden="true" size={20} weight="light" /><span>{session.title}</span></button>)}</div>
    <div className="network-specialist"><Graph aria-hidden="true" size={26} weight="light" /><span>Saved brief</span></div><div className="network-answer"><ChatCircle aria-hidden="true" size={24} weight="light" /><span>Specialist</span></div>
  </div>;
}
export function LibraryIllustration() {
  return <div className="library-illustration" aria-hidden="true"><svg viewBox="0 0 560 250" className="illustration-wires"><path d="M110 48 C260 48 180 126 285 126" /><path d="M110 122 L285 126" /><path d="M110 202 C220 202 220 126 285 126" /><path className="network-wire-active" d="M285 126 C370 126 350 100 470 100" /></svg><div className="illustration-session session-one"><Stack size={20} weight="light" /><span className="mock-line" /><span className="mock-line short-line" /></div><div className="illustration-session session-two"><Stack size={20} weight="light" /><span className="mock-line" /><span className="mock-line short-line" /></div><div className="illustration-session session-three"><Stack size={20} weight="light" /><span className="mock-line" /><span className="mock-line short-line" /></div><div className="illustration-specialist"><Graph size={44} weight="light" /><span className="mock-line" /></div><div className="illustration-question"><ChatCircle size={22} weight="light" /><span className="mock-line" /></div></div>;
}
