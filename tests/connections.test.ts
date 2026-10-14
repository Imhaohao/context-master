import { describe, expect, it } from 'vitest';
import { agentConnections, shellQuote } from '../src/core/connections';

describe('agent connection commands', () => {
  it('quotes paths with spaces and passes environment flags in each CLI syntax', () => {
    const [claude, codex] = agentConnections({
      command: '/Applications/Context Master.app/Contents/MacOS/Context Master',
      args: ['/Applications/Context Master.app/Contents/Resources/agent/mcp.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    });
    expect(claude).toEqual({ agent: 'Claude Code', command: "claude mcp add --scope user context-master -e ELECTRON_RUN_AS_NODE=1 -- '/Applications/Context Master.app/Contents/MacOS/Context Master' '/Applications/Context Master.app/Contents/Resources/agent/mcp.cjs'" });
    expect(codex.command).toBe("codex mcp add context-master --env ELECTRON_RUN_AS_NODE=1 -- '/Applications/Context Master.app/Contents/MacOS/Context Master' '/Applications/Context Master.app/Contents/Resources/agent/mcp.cjs'");
  });

  it('escapes single quotes so a pasted command cannot break out of its argument', () => {
    expect(shellQuote("/tmp/it's here")).toBe(`'/tmp/it'\\''s here'`);
    expect(shellQuote('/usr/local/bin/node')).toBe('/usr/local/bin/node');
  });
});
