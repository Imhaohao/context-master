'use client';
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { X, SpinnerGap, Check } from '@phosphor-icons/react';
export function Button({ children, variant = 'secondary', busy = false, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; busy?: boolean }) {
  return <button {...props} disabled={props.disabled || busy} className={`button button-${variant} ${className}`} aria-busy={busy || undefined}>
    {busy && <SpinnerGap className="spin" aria-hidden="true" size={18} />} {children}
  </button>;
}
export function IconButton({ label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button {...props} className={`icon-button ${props.className ?? ''}`} aria-label={label} title={label}>{children}</button>;
}
export function Dialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current; const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }} aria-labelledby={titleId}>
    <div className="modal-heading"><h2 id={titleId}>{title}</h2><IconButton label={`Close ${title}`} onClick={onClose}><X size={20} aria-hidden="true" /></IconButton></div>
    {children}
  </dialog>;
}
export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon" aria-hidden="true">{icon}</div><h2>{title}</h2>{children}</div>;
}
export function Badge({ children, active = false }: { children: ReactNode; active?: boolean }) {
  return <span className={`badge ${active ? 'badge-active' : ''}`}>{active && <Check size={12} aria-hidden="true" />}{children}</span>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? 'The request failed. Try again.');
  return data;
}
export function requestBody(data: unknown): RequestInit { return { method: 'POST', body: JSON.stringify(data) }; }
export function relativeTime(value: string): string {
  const date = new Date(value); const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export const sourceNames: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor', chatgpt: 'ChatGPT', generic: 'Transcript' };
export function ErrorNotice({ message }: { message: string }) { return <p className="error-notice" role="alert">{message}</p>; }
export function counted(count: number, word: string): string { return `${count} ${word}${count === 1 ? '' : 's'}`; }
