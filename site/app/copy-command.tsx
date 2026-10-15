'use client';
import { useState } from 'react';
import { Check, Copy } from '@phosphor-icons/react';

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(command); setCopied(true); } catch { setCopied(false); }
  }
  return <div className="command">
    <pre>{command}</pre>
    <button type="button" className="button button-quiet" onClick={copy}>
      {copied ? <Check size={16} weight="bold" aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  </div>;
}
