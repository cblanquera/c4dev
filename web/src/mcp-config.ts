/**
 * Reads the MCP server JSON that READMEs, Claude Desktop and Claude Code use,
 * so a context can be filled in by pasting it: `{ "mcpServers": { name: {…} } }`,
 * `{ name: {…} }`, or one server `{ command, args, env }` / `{ url, headers }`.
 */
export interface ParsedServer {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  cwd: string;
  url: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  /** Codex's names for values taken from the environment. */
  bearerTokenEnv: string;
  envHeaders: Record<string, string>;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): Record<string, string> => (isObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])) : {});
const isServer = (v: unknown): v is Record<string, unknown> => isObject(v) && (typeof v.command === 'string' || typeof v.url === 'string');

/** The servers in a pasted config. Throws a readable error for anything else. */
export function parseMcpConfig(text: string): ParsedServer[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That isn't valid JSON");
  }
  const servers: [string, Record<string, unknown>][] = isServer(data)
    ? [['', data]]
    : Object.entries(isObject(data) && isObject(data.mcpServers) ? data.mcpServers : isObject(data) ? data : {}).filter((e): e is [string, Record<string, unknown>] => isServer(e[1]));
  if (!servers.length) throw new Error('No MCP server found: expected "command" or "url", e.g. { "mcpServers": { "github": { "command": "npx", … } } }');
  return servers.map(([name, s]) => {
    const http = typeof s.url === 'string' && typeof s.command !== 'string';
    return {
      name: name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40),
      transport: http ? 'http' : 'stdio',
      command: http ? '' : String(s.command),
      args: !http && Array.isArray(s.args) ? s.args.map(String) : [],
      cwd: !http && typeof s.cwd === 'string' ? s.cwd : '',
      url: http ? String(s.url) : '',
      env: http ? {} : strings(s.env),
      headers: http ? strings(s.headers ?? s.http_headers) : {},
      bearerTokenEnv: http && typeof s.bearer_token_env_var === 'string' ? s.bearer_token_env_var : '',
      envHeaders: http ? strings(s.env_http_headers) : {},
    };
  });
}
