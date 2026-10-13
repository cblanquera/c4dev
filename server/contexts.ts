/**
 * The contexts library: what agents can be given beyond the repository. An
 * MCP server is started from a command (stdio) or reached at a URL
 * (streamable HTTP); its environment and header values are secrets, stored
 * encrypted and only handed to the runs that start it. A local folder of
 * Markdown knowledge needs no server: its entry document (AGENTS.md or
 * CONTEXT.md) goes into each run's instructions and agents read the files it
 * links to, which works on every provider, Pi included. Workers get every
 * context their agent has; read-only roles only get read-only ones (folders
 * always are), so they can't write through an MCP tool either.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from './db.ts';
import { HttpError } from './errors.ts';
import type { AgentProfile, Context } from './types.ts';

const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CHECK_MS = 20_000;
const PROTOCOL = '2025-06-18';
/** Where a folder's entry document can be, in order. `.agents/` is the ChrisAI Agent Workspace layout. */
export const ENTRY_FILES = ['AGENTS.md', 'CONTEXT.md', '.agents/AGENTS.md', '.agents/CONTEXT.md'];
/** Entry documents are meant to be compact indexes; anything beyond this is cut, with a note. */
const MAX_ENTRY_CHARS = 24_000;
const MAX_SCAN = 5_000;

/** A context as a run starts it, secrets included. Never sent to clients or logged. */
export interface RunContext {
  name: string;
  transport: Context['transport'];
  /** folder: the absolute folder, its entry document's path and its text. */
  folder?: string;
  entry?: string;
  entryText?: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  readOnly: boolean;
}

/** Environment or header values from a form: a value replaces, `null` keeps the saved one, a missing name removes it. */
export type SecretPatch = Record<string, string | null>;

function cleanSecrets(patch: unknown, saved: Record<string, string>, valid: RegExp, what: string): Record<string, string> {
  if (patch === undefined) return saved;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, `${what} must be name/value pairs`);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(patch as SecretPatch)) {
    if (!valid.test(name)) throw new HttpError(400, `"${name}" isn't a valid ${what.toLowerCase()} name`);
    if (value === null) {
      if (!(name in saved)) throw new HttpError(400, `${name} has no saved value; enter one`);
      out[name] = saved[name];
    } else {
      out[name] = String(value);
    }
  }
  return out;
}

function cleanNames(value: unknown, fallback: string[], what: string): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) throw new HttpError(400, `${what} must be a list of variable names`);
  const names = value.map((v) => String(v).trim()).filter(Boolean);
  const bad = names.find((n) => !ENV_NAME.test(n));
  if (bad) throw new HttpError(400, `"${bad}" isn't a valid variable name`);
  return [...new Set(names)];
}

function cleanEnvHeaders(value: unknown, fallback: Record<string, string>): Record<string, string> {
  if (value === undefined) return fallback;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Headers from environment variables must be header/variable pairs');
  const out: Record<string, string> = {};
  for (const [header, variable] of Object.entries(value as Record<string, unknown>)) {
    if (!HEADER_NAME.test(header)) throw new HttpError(400, `"${header}" isn't a valid header name`);
    if (!ENV_NAME.test(String(variable))) throw new HttpError(400, `"${variable}" isn't a valid variable name`);
    out[header] = String(variable);
  }
  return out;
}

function cleanContext(input: Record<string, unknown>, existing?: Context): db.ContextInput {
  const saved = existing ? db.contextSecrets(existing.id) : { env: {}, headers: {} };
  const name = String(input.name ?? existing?.name ?? '').trim();
  if (!NAME.test(name)) throw new HttpError(400, 'A context name has only letters, digits, - and _ (up to 40), e.g. github or linear-docs');
  if (name.toLowerCase() === 'factory') throw new HttpError(400, '"factory" is the name of the factory\'s own tools; choose another');
  const clash = db.listContexts().find((c) => c.name.toLowerCase() === name.toLowerCase() && c.id !== existing?.id);
  if (clash) throw new HttpError(409, `A context called "${clash.name}" already exists`);
  const transport = (input.transport ?? existing?.transport ?? 'stdio') as Context['transport'];
  if (!['stdio', 'http', 'folder'].includes(transport)) throw new HttpError(400, 'A context is started from a command, reached at a URL, or read from a local folder');
  const folder = String(input.folder ?? existing?.folder ?? '').trim();
  if (transport === 'folder') {
    if (!folder) throw new HttpError(400, 'Choose the folder that holds the knowledge');
    const dir = expandHome(folder);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new HttpError(400, `No folder at ${dir}`);
    if (!findEntry(dir)) throw new HttpError(400, `${dir} has no ${ENTRY_FILES.join(', ')}; agents start from one of these`);
  }
  const command = String(input.command ?? existing?.command ?? '').trim();
  const args = Array.isArray(input.args) ? input.args.map(String).filter((a) => a !== '') : existing?.args ?? [];
  const url = String(input.url ?? existing?.url ?? '').trim();
  if (transport === 'stdio' && !command) throw new HttpError(400, 'Enter the command that starts the MCP server, e.g. npx');
  if (transport === 'http') {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpError(400, 'Enter the MCP server URL, e.g. https://mcp.example.com/mcp');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new HttpError(400, 'MCP server URLs start with https:// or http://');
  }
  const stdio = transport === 'stdio';
  const bearer = String(input.bearerTokenEnv ?? existing?.bearerTokenEnv ?? '').trim();
  if (bearer && !ENV_NAME.test(bearer)) throw new HttpError(400, `"${bearer}" isn't a valid variable name`);
  const http = transport === 'http';
  return {
    name,
    description: String(input.description ?? existing?.description ?? '').trim().slice(0, 300),
    transport,
    folder: transport === 'folder' ? folder : '',
    command: stdio ? command : '',
    args: stdio ? args.slice(0, 100) : [],
    cwd: stdio ? String(input.cwd ?? existing?.cwd ?? '').trim() : '',
    envPassthrough: stdio ? cleanNames(input.envPassthrough, existing?.envPassthrough ?? [], 'Passthrough') : [],
    url: http ? url : '',
    bearerTokenEnv: http ? bearer : '',
    envHeaders: http ? cleanEnvHeaders(input.envHeaders, existing?.envHeaders ?? {}) : {},
    env: transport === 'stdio' ? cleanSecrets(input.env, saved.env, ENV_NAME, 'Environment variable') : {},
    headers: transport === 'http' ? cleanSecrets(input.headers, saved.headers, HEADER_NAME, 'Header') : {},
    // Agents only ever read a knowledge folder, so every role may have it.
    readOnly: transport === 'folder' || (typeof input.readOnly === 'boolean' ? input.readOnly : existing?.readOnly ?? false),
    enabled: typeof input.enabled === 'boolean' ? input.enabled : existing?.enabled ?? true,
  };
}

export function saveContext(input: Record<string, unknown>, id?: number): Context {
  const existing = id == null ? undefined : db.getContext(id);
  if (id != null && !existing) throw new HttpError(404, `Context ${id} not found`);
  const clean = cleanContext(input, existing);
  return existing ? db.updateContextRow(existing.id, clean)! : db.insertContext(clean);
}

/** Deleting a context detaches it from every agent first. */
export function deleteContext(id: number, detach: (profile: AgentProfile, contextIds: number[]) => void): void {
  if (!db.getContext(id)) throw new HttpError(404, `Context ${id} not found`);
  for (const profile of db.activeProfiles()) {
    if (profile.contextIds.includes(id)) detach(profile, profile.contextIds.filter((c) => c !== id));
  }
  db.deleteContextRow(id);
}

/**
 * A context as it starts now: saved secrets plus values taken from the
 * factory's environment (passthrough variables, bearer token, header
 * variables), and a working directory applied by wrapping the command in
 * `sh`, since not every provider has a setting for it. `missing` names
 * variables the factory's environment doesn't have.
 */
const expandHome = (p: string) => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));

/** The folder's entry document, relative to it, or null. */
export function findEntry(dir: string): string | null {
  return ENTRY_FILES.find((f) => {
    try {
      return fs.statSync(path.join(dir, f)).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

/** A knowledge folder as a run reads it now: its entry document's text, capped. */
function resolveFolder(c: Context): RunContext & { missing: string[] } {
  const folder = expandHome(c.folder);
  const entry = findEntry(folder);
  let entryText = '';
  if (entry) {
    const text = fs.readFileSync(path.join(folder, entry), 'utf8');
    entryText = text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS)}\n\n[… cut at ${MAX_ENTRY_CHARS} characters; read the file for the rest]` : text;
  }
  return {
    name: c.name, transport: 'folder', folder, entry: entry ? path.join(folder, entry) : '', entryText,
    command: '', args: [], env: {}, url: '', headers: {}, readOnly: true, missing: entry ? [] : [ENTRY_FILES.join(' or ')],
  };
}

export function resolveContext(c: Context): RunContext & { missing: string[] } {
  if (c.transport === 'folder') return resolveFolder(c);
  const secrets = db.contextSecrets(c.id);
  const missing: string[] = [];
  const fromEnv = (name: string) => {
    const value = process.env[name];
    if (value === undefined) missing.push(name);
    return value;
  };
  const env: Record<string, string> = {};
  for (const name of c.envPassthrough) {
    const value = fromEnv(name);
    if (value !== undefined) env[name] = value;
  }
  const headers: Record<string, string> = {};
  for (const [header, variable] of Object.entries(c.envHeaders)) {
    const value = fromEnv(variable);
    if (value !== undefined) headers[header] = value;
  }
  if (c.bearerTokenEnv) {
    const token = fromEnv(c.bearerTokenEnv);
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  }
  const cwd = c.cwd.replace(/^~(?=$|\/)/, os.homedir());
  const command = c.transport === 'stdio' && cwd
    ? { command: '/bin/sh', args: ['-c', 'cd -- "$1" && shift && exec "$@"', 'sh', path.resolve(cwd), c.command, ...c.args] }
    : { command: c.command, args: c.args };
  return {
    name: c.name, transport: c.transport, ...command, url: c.url,
    env: { ...env, ...secrets.env }, headers: { ...headers, ...secrets.headers }, readOnly: c.readOnly, missing,
  };
}

/** Every switched-on context an agent has, ready to start. Drivers pick what a run may use with `contextsFor`. */
export function runContexts(profile: Pick<AgentProfile, 'contextIds'>): RunContext[] {
  return profile.contextIds.map((id) => db.getContext(id)).filter((c): c is Context => !!c && c.enabled).map((c) => {
    const { missing: _missing, ...run } = resolveContext(c);
    return run;
  });
}

// ------------------------------------------------------------ checking

type Rpc = { id?: number; result?: any; error?: { message?: string } };

/** Markdown files under a folder, skipping .git and node_modules, up to a cap. */
function countMarkdown(dir: string): number {
  let count = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (count >= MAX_SCAN) return;
      if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') walk(path.join(d, e.name));
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) count++;
    }
  };
  walk(dir);
  return count;
}

/**
 * Starts a context and asks for its tools, so the user knows it works before
 * agents rely on it. A folder is checked for its entry document instead.
 */
export async function checkContext(id: number): Promise<{ tools: string[]; server: string; files?: number }> {
  const context = db.getContext(id);
  if (!context) throw new HttpError(404, `Context ${id} not found`);
  if (context.transport === 'folder') {
    const run = resolveFolder(context);
    if (!run.entry) throw new HttpError(502, `${context.name}: ${run.folder} has no ${ENTRY_FILES.join(', ')}`);
    return { server: path.relative(run.folder!, run.entry), tools: [], files: countMarkdown(run.folder!) };
  }
  const run = resolveContext(context);
  const unset = run.missing.length ? ` (not set in the factory's environment: ${run.missing.join(', ')})` : '';
  try {
    return context.transport === 'stdio'
      ? await checkStdio(run.command, run.args, run.env)
      : await checkHttp(run.url, run.headers);
  } catch (err) {
    throw new HttpError(502, `${context.name} didn't answer: ${err instanceof Error ? err.message : String(err)}${unset}`);
  }
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'software-factory', version: '1' } } };
const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const summarize = (init: any, list: any) => ({
  server: [init?.serverInfo?.name, init?.serverInfo?.version].filter(Boolean).join(' ') || 'MCP server',
  tools: (list?.tools ?? []).map((t: { name?: unknown }) => String(t.name ?? '')).filter(Boolean),
});

function checkStdio(command: string, args: string[], env: Record<string, string>): Promise<{ tools: string[]; server: string }> {
  return new Promise((resolve, reject) => {
    const { NODE_TEST_CONTEXT: _ignored, ...parentEnv } = process.env;
    const child = spawn(command, args, { env: { ...parentEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let stderr = '';
    let init: any;
    const finish = (err: Error | null, value?: { tools: string[]; server: string }) => {
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error(`no answer within ${CHECK_MS / 1000}s${stderr ? `\n${stderr.trim().split('\n').slice(-3).join('\n')}` : ''}`)), CHECK_MS);
    const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    child.on('error', (err) => finish(new Error(`couldn't start ${command}: ${err.message}`)));
    child.on('exit', (code) => finish(new Error(`it exited (code ${code})${stderr ? `\n${stderr.trim().split('\n').slice(-3).join('\n')}` : ''}`)));
    child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        let msg: Rpc;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.error) return finish(new Error(msg.error.message ?? 'error'));
        if (msg.id === 1) {
          init = msg.result;
          send(initialized);
          send(listTools);
        } else if (msg.id === 2) {
          finish(null, summarize(init, msg.result));
        }
      }
    });
    send(initialize);
  });
}

/** One JSON-RPC message over streamable HTTP, answered as JSON or as an event stream. */
async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<{ msg: Rpc | null; session: string | null }> {
  const res = await fetch(url, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status}${res.status === 401 ? ' (check the headers, e.g. Authorization)' : ''}`);
  const session = res.headers.get('mcp-session-id');
  const text = await res.text();
  if (!text.trim()) return { msg: null, session };
  const payloads = (res.headers.get('content-type') ?? '').includes('event-stream')
    ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
    : [text];
  for (const payload of payloads) {
    try {
      const msg = JSON.parse(payload) as Rpc;
      if (msg.id !== undefined || msg.error) return { msg, session };
    } catch {
      // Not JSON; keep looking.
    }
  }
  return { msg: null, session };
}

async function checkHttp(url: string, headers: Record<string, string>): Promise<{ tools: string[]; server: string }> {
  const signal = AbortSignal.timeout(CHECK_MS);
  const first = await post(url, headers, initialize, signal);
  if (first.msg?.error) throw new Error(first.msg.error.message ?? 'error');
  const next = { ...headers, 'mcp-protocol-version': first.msg?.result?.protocolVersion ?? PROTOCOL, ...(first.session ? { 'mcp-session-id': first.session } : {}) };
  await post(url, next, initialized, signal);
  const list = await post(url, next, listTools, signal);
  if (list.msg?.error) throw new Error(list.msg.error.message ?? 'error');
  return summarize(first.msg?.result, list.msg?.result);
}
