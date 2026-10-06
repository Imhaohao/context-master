'use client';
import { useEffect, useState } from 'react';
import { Check, Copy, Terminal, PlugsConnected, ArrowSquareOut } from '@phosphor-icons/react';
import { AppearanceControl } from './appearance';
import { api, Badge, Button, ErrorNotice, sourceNames } from './ui';
import type { AgentCli } from '@/core/types';
interface Settings { clis: { id: AgentCli; name: string; installed: boolean; ready: boolean; path?: string; version?: string; detail?: string }[]; dataDirectory: string; mcp: { command: string; args: string[]; env: Record<string, string> } }
export function ConnectionsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null); const [error, setError] = useState(''); const [copied, setCopied] = useState(false); const [busy, setBusy] = useState(false);
  async function refresh() { setBusy(true); setError(''); try { setSettings(await api<Settings>('/api/settings')); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not inspect local agents.'); } finally { setBusy(false); } }
  useEffect(() => { let live = true; api<Settings>('/api/settings').then(data => { if (live) setSettings(data); }).catch(cause => { if (live) setError(cause.message); }); return () => { live = false; }; }, []);
  const config = settings ? JSON.stringify({ mcpServers: { 'context-master': settings.mcp } }, null, 2) : '';
  async function copy() { try { await navigator.clipboard.writeText(config); setCopied(true); } catch { setError('Could not copy. Select the configuration below and copy it manually.'); } }
  return <div className="panel-content connections-panel">
    <section><div className="section-heading"><h2>Local agents</h2><Button busy={busy} variant="ghost" onClick={refresh}>Check again</Button></div><p className="muted">Specialists use your installed CLI login and subscription. Log in through the agent’s own terminal command.</p>
      <div className="agent-list">{settings?.clis.map(cli => <div className="agent-row" key={cli.id}><Terminal aria-hidden="true" size={24} weight="light" /><div className="min-w-0"><strong>{sourceNames[cli.id]}</strong><p className="muted text-sm break-word">{cli.detail ?? cli.version ?? 'No CLI found in the standard executable paths.'}</p>{cli.path && <code className="path-text">{cli.path}</code>}</div><Badge active={cli.ready}>{cli.ready ? 'Ready' : cli.installed ? 'Blocked' : 'Not found'}</Badge></div>)}</div>
      {!settings && !error && <p role="status" className="loading-state">Checking installed CLIs…</p>}
    </section>
    <section><div className="section-heading"><h2>Connect another agent</h2><PlugsConnected size={24} aria-hidden="true" weight="light" /></div><p className="muted">Add this Model Context Protocol server to your agent’s configuration. It exposes specialist search, context handoff, and consultation.</p><div className="code-block"><pre>{config || 'Loading the local connection configuration…'}</pre><Button onClick={copy} disabled={!settings} variant="ghost">{copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}{copied ? 'Copied configuration' : 'Copy configuration'}</Button></div>
      <details className="connection-guide"><summary>Where to add the configuration</summary><dl><dt>Claude Code</dt><dd>Add the server to your project’s <code>.mcp.json</code> or use <code>claude mcp add</code>.</dd><dt>Cursor</dt><dd>Add the server under <code>mcpServers</code> in <code>~/.cursor/mcp.json</code>.</dd><dt>Codex</dt><dd>Add <code>[mcp_servers.context-master]</code> in <code>~/.codex/config.toml</code> with the command, args, and env above.</dd><dt>OpenCode</dt><dd>Add a local server under <code>mcp</code> in your OpenCode configuration. Its command is an array containing the command and args above.</dd></dl><a href="https://modelcontextprotocol.io/docs/develop/connect-local-servers" target="_blank" rel="noreferrer">Read local server setup <ArrowSquareOut size={16} aria-hidden="true" /></a></details>
    </section>
    <section className="appearance-section"><h2>Appearance</h2><AppearanceControl /></section>
    {settings && <section><h2>Library location</h2><code className="path-text">{settings.dataDirectory}</code><p className="field-hint">The Mac app and tool server share this local library. No cloud sync is configured.</p></section>}
    {error && <ErrorNotice message={error} />}
  </div>;
}
