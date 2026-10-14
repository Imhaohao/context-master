'use client';
import { useEffect, useState } from 'react';
import { Check, Copy, Terminal } from '@phosphor-icons/react';
import { AppearanceControl } from './appearance';
import { api, Badge, Button, ErrorNotice, sourceNames } from './ui';
import type { AgentCli } from '@/core/types';
import type { AgentConnection, McpLaunch } from '@/core/connections';
interface CliStatus { id: AgentCli; name: string; installed: boolean; ready: boolean; path?: string; version?: string; detail?: string }
interface Settings { clis: CliStatus[]; dataDirectory: string; mcp: McpLaunch; connections: AgentConnection[] }
function CopyCommand({ label, text, onError }: { label: string; text: string; onError: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { onError(); } }
  return <Button onClick={copy} variant="ghost">{copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}{copied ? 'Copied' : label}</Button>;
}
function ConnectAgents({ settings, onCopyError }: { settings: Settings | null; onCopyError: () => void }) {
  if (!settings) return <p role="status" className="loading-state">Preparing the connection commands…</p>;
  const config = JSON.stringify({ mcpServers: { 'context-master': settings.mcp } }, null, 2);
  return <>
    {settings.connections.map(connection => <div className="code-block" key={connection.agent}><h3>{connection.agent}</h3><pre>{connection.command}</pre><CopyCommand label="Copy command" text={connection.command} onError={onCopyError} /></div>)}
    <details className="connection-guide"><summary>Other agents</summary><p className="muted text-sm">Cursor, OpenCode and other agents read a Model Context Protocol server entry like this one from their own configuration file.</p><div className="code-block"><pre>{config}</pre><CopyCommand label="Copy configuration" text={config} onError={onCopyError} /></div></details>
  </>;
}
function cliState(cli: CliStatus) { return cli.ready ? 'Ready' : cli.installed ? 'Blocked' : 'Not found'; }
function AnsweringAgents({ clis }: { clis?: CliStatus[] }) {
  if (!clis) return <p role="status" className="loading-state">Checking installed CLIs…</p>;
  return <div className="agent-list">{clis.map(cli => <div className="agent-row" key={cli.id}><Terminal aria-hidden="true" size={24} weight="light" /><div className="min-w-0"><strong>{sourceNames[cli.id]}</strong><p className="muted text-sm break-word">{cli.detail ?? cli.version ?? 'No CLI found in the standard executable paths.'}</p>{cli.path && <code className="path-text">{cli.path}</code>}</div><Badge active={cli.ready}>{cliState(cli)}</Badge></div>)}</div>;
}
export function ConnectionsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function refresh() { setBusy(true); setError(''); try { setSettings(await api<Settings>('/api/settings')); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not inspect local agents.'); } finally { setBusy(false); } }
  useEffect(() => { let live = true; api<Settings>('/api/settings').then(data => { if (live) setSettings(data); }).catch(cause => { if (live) setError(cause.message); }); return () => { live = false; }; }, []);
  return <div className="panel-content connections-panel">
    <section><h2>Connect another agent</h2><p className="muted">Run one command in a terminal. The agent can then search your specialists and ask them questions from any project.</p><ConnectAgents settings={settings} onCopyError={() => setError('Could not copy. Select the text and copy it manually.')} /></section>
    <section><div className="section-heading"><h2>Answering agents</h2><Button busy={busy} variant="ghost" onClick={refresh}>Check again</Button></div><p className="muted">A specialist answers through one of these CLIs, using its existing login and subscription.</p><AnsweringAgents clis={settings?.clis} /></section>
    <section className="appearance-section"><h2>Appearance</h2><AppearanceControl /></section>
    {settings && <section><h2>Library location</h2><code className="path-text">{settings.dataDirectory}</code><p className="field-hint">The Mac app and the agent connection share this local library. Nothing is synced to a cloud service.</p></section>}
    {error && <ErrorNotice message={error} />}
  </div>;
}
