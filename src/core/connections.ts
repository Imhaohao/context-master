export interface McpLaunch { command: string; args: string[]; env: Record<string, string> }
export interface AgentConnection { agent: string; command: string }

export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function envFlags(flag: string, env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => [flag, shellQuote(`${key}=${value}`)]);
}

export function agentConnections(launch: McpLaunch): AgentConnection[] {
  const server = [launch.command, ...launch.args].map(shellQuote).join(' ');
  return [
    { agent: 'Claude Code', command: ['claude mcp add --scope user context-master', ...envFlags('-e', launch.env), '--', server].join(' ') },
    { agent: 'Codex', command: ['codex mcp add context-master', ...envFlags('--env', launch.env), '--', server].join(' ') }
  ];
}
