/**
 * Settings → Contexts: the library of MCP servers agents can be given, one row
 * each with a switch to turn it off everywhere. The editor connects by command
 * (STDIO) or URL (streamable HTTP). Environment and header values are secrets
 * the server keeps encrypted and never sends back, so the editor only shows
 * which names have a saved value; values can also come from the factory's own
 * environment by name.
 */
import { Icon } from './Icon.tsx';
import { useState, type ReactNode } from 'react';
import { api, type ContextInput } from '../api.ts';
import { parseMcpConfig } from '../mcp-config.ts';
import { useChooseFolder } from './FolderPicker.tsx';
import type { AgentProfile, Context } from '../../../server/types.ts';

const failure = (err: unknown) => (err instanceof Error ? err.message : 'Failed');

interface Props {
  contexts: Map<number, Context>;
  profiles: AgentProfile[];
  onError: (message: string) => void;
}

export function ContextsSection({ contexts, profiles, onError }: Props) {
  const [editing, setEditing] = useState<Context | 'new' | null>(null);
  const [switching, setSwitching] = useState<number | null>(null);
  const library = [...contexts.values()].sort((a, b) => a.name.localeCompare(b.name));
  const usedBy = (id: number) => profiles.filter((p) => !p.archived && p.contextIds.includes(id)).map((p) => p.name);

  async function toggle(context: Context) {
    setSwitching(context.id);
    try {
      await api.updateContext(context.id, { enabled: !context.enabled });
    } catch (err) {
      onError(failure(err));
    } finally {
      setSwitching(null);
    }
  }

  return (
    <div className="contexts">
      <div className="agents-head">
        <p className="field-hint">Connect external tools and data sources (MCP servers or local knowledge folders), then attach them to agents in each agent's Contexts tab.</p>
        <button className="primary small" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> Add Context</button>
      </div>
      <ul className="ctx-list" aria-label="Contexts">
        {!library.length && <li className="ctx-row muted small">No contexts yet. Add an MCP server or a knowledge folder, then attach it to agents.</li>}
        {library.map((context) => {
          const users = usedBy(context.id);
          return (
            <li key={context.id} className={`ctx-row ${context.enabled ? '' : 'is-off'}`}>
              <div className="ctx-row-main">
                <span className="context-title">
                  <strong className="mono">{context.name}</strong>
                  {context.transport === 'folder' ? <span className="badge subtle">folder</span> : context.readOnly && <span className="badge subtle">read-only</span>}
                  {!context.enabled && <span className="badge subtle">off</span>}
                </span>
                <span className="muted small">{users.length ? `Used by ${users.join(', ')}` : 'Not used by any agent'}</span>
              </div>
              <button className="ghost small" aria-label={`Edit ${context.name}`} title="Edit" onClick={() => setEditing(context)}><Icon name="settings" size={16} /></button>
              <button className={`toggle ${context.enabled ? 'on' : ''}`} role="switch" aria-checked={context.enabled} aria-label={`Use ${context.name}`}
                title={context.enabled ? 'On: agents it is attached to can use it' : 'Off: no agent starts it'} disabled={switching === context.id} onClick={() => toggle(context)}>
                <span className="knob" />
              </button>
            </li>
          );
        })}
      </ul>
      {editing && <ContextEditor context={editing === 'new' ? null : editing} usedBy={editing === 'new' ? [] : usedBy(editing.id)} onClose={() => setEditing(null)} onError={onError} />}
    </div>
  );
}

// ------------------------------------------------------------ the editor

let rowKey = 0;
const nextKey = () => ++rowKey;

/** One entry in a repeating list. `saved` marks a secret whose value the server holds. */
interface Row {
  key: number;
  name: string;
  value: string;
  saved?: boolean;
}

const single = (values: string[]): Row[] => (values.length ? values : ['']).map((value) => ({ key: nextKey(), name: '', value }));
const pairs = (entries: [string, string][], blank = true): Row[] => (entries.length || !blank ? entries : [['', '']]).map(([name, value]) => ({ key: nextKey(), name, value }));
const savedPairs = (names: string[]): Row[] => (names.length ? names.map((name) => ({ key: nextKey(), name, value: '', saved: true })) : pairs([]));

/** Secret rows as the API takes them: a typed value replaces, an untouched saved one is kept (null). */
const secretPatch = (list: Row[]) => Object.fromEntries(list.filter((r) => r.name.trim()).map((r) => [r.name.trim(), r.value === '' && r.saved ? null : r.value]));
const pairMap = (list: Row[]) => Object.fromEntries(list.filter((r) => r.name.trim() && r.value.trim()).map((r) => [r.name.trim(), r.value.trim()]));
const values = (list: Row[]) => list.map((r) => r.value.trim()).filter(Boolean);

function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="ctx-card" aria-label={title}>
      {title && <h3>{title}</h3>}
      {children}
    </section>
  );
}

/** A list of single values: arguments, passthrough variables. */
function ValueRows({ rows, onChange, placeholder, label, add }: { rows: Row[]; onChange: (rows: Row[]) => void; placeholder: string; label: string; add: string }) {
  return <>
    {rows.map((row, i) => (
      <div key={row.key} className="repeat-row">
        <input className="mono" aria-label={`${label} ${i + 1}`} placeholder={placeholder} value={row.value}
          onChange={(e) => onChange(rows.map((r) => (r.key === row.key ? { ...r, value: e.target.value } : r)))} />
        <button className="ghost small" aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} onClick={() => onChange(rows.filter((r) => r.key !== row.key))}><Icon name="trash" size={14} /></button>
      </div>
    ))}
    <button className="add-row" onClick={() => onChange([...rows, { key: nextKey(), name: '', value: '' }])}>+ {add}</button>
  </>;
}

/** Name/value pairs; `secret` hides values and keeps saved ones unless retyped. */
function PairRows({ rows, onChange, names, secret, add }: {
  rows: Row[]; onChange: (rows: Row[]) => void; names: [string, string]; secret?: boolean; add: string;
}) {
  const update = (key: number, patch: Partial<Row>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return <>
    {rows.map((row, i) => (
      <div key={row.key} className="repeat-row">
        <input className="mono" aria-label={`${names[0]} ${i + 1}`} placeholder={names[0]} value={row.name}
          onChange={(e) => update(row.key, { name: e.target.value, saved: false })} />
        <input className="mono" type={secret ? 'password' : 'text'} autoComplete="off" aria-label={`${names[1]} for ${row.name || `row ${i + 1}`}`}
          placeholder={row.saved ? 'Saved · type to replace' : names[1]} value={row.value} onChange={(e) => update(row.key, { value: e.target.value })} />
        <button className="ghost small" aria-label={`Remove ${row.name || `row ${i + 1}`}`} onClick={() => onChange(rows.filter((r) => r.key !== row.key))}><Icon name="trash" size={14} /></button>
      </div>
    ))}
    <button className="add-row" onClick={() => onChange([...rows, { key: nextKey(), name: '', value: '' }])}>+ {add}</button>
  </>;
}

function ContextEditor({ context, usedBy, onClose, onError }: { context: Context | null; usedBy: string[]; onClose: () => void; onError: (m: string) => void }) {
  /** Saved by Test connection, so a new context can be tested before closing. */
  const [current, setCurrent] = useState<Context | null>(context);
  const [name, setName] = useState(context?.name ?? '');
  const [transport, setTransport] = useState<Context['transport']>(context?.transport ?? 'stdio');
  const [folder, setFolder] = useState(context?.folder ?? '');
  const folders = useChooseFolder(setFolder, onError);
  const [command, setCommand] = useState(context?.command ?? '');
  const [args, setArgs] = useState<Row[]>(single(context?.args ?? []));
  const [env, setEnv] = useState<Row[]>(savedPairs(context?.envNames ?? []));
  const [passthrough, setPassthrough] = useState<Row[]>(single(context?.envPassthrough ?? []));
  const [cwd, setCwd] = useState(context?.cwd ?? '');
  const [url, setUrl] = useState(context?.url ?? '');
  const [bearer, setBearer] = useState(context?.bearerTokenEnv ?? '');
  const [headers, setHeaders] = useState<Row[]>(savedPairs(context?.headerNames ?? []));
  const [envHeaders, setEnvHeaders] = useState<Row[]>(pairs(Object.entries(context?.envHeaders ?? {})));
  const [readOnly, setReadOnly] = useState(context?.readOnly ?? false);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [pasteError, setPasteError] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

  function fillFromJson() {
    try {
      const [server] = parseMcpConfig(pasted);
      if (server.name && !name) setName(server.name);
      setTransport(server.transport);
      setCommand(server.command);
      setArgs(single(server.args));
      setCwd(server.cwd);
      setEnv(pairs(Object.entries(server.env)));
      setUrl(server.url);
      setBearer(server.bearerTokenEnv);
      setHeaders(pairs(Object.entries(server.headers)));
      setEnvHeaders(pairs(Object.entries(server.envHeaders)));
      setPasteError('');
      setPasted('');
      setPasting(false);
    } catch (err) {
      setPasteError(failure(err));
    }
  }

  const body = (): ContextInput => ({
    name: name.trim(), description: current?.description ?? '', transport, readOnly, folder: folder.trim(),
    command: command.trim(), args: values(args), cwd: cwd.trim(), envPassthrough: values(passthrough), env: secretPatch(env),
    url: url.trim(), bearerTokenEnv: bearer.trim(), headers: secretPatch(headers), envHeaders: pairMap(envHeaders),
  });

  async function persist(): Promise<Context> {
    const saved = await (current ? api.updateContext(current.id, body()) : api.createContext(body()));
    setCurrent(saved);
    return saved;
  }

  async function save() {
    setBusy('save');
    try {
      await persist();
      onClose();
    } catch (err) {
      onError(failure(err));
    } finally {
      setBusy(null);
    }
  }

  async function testConnection() {
    setBusy('test');
    setTest(null);
    try {
      const saved = await persist();
      const { server, tools, files } = await api.checkContext(saved.id);
      setTest({
        ok: true,
        text: files !== undefined
          ? `Found ${server} · ${files} Markdown file${files === 1 ? '' : 's'} in the folder`
          : `Connected to ${server} · ${tools.length} tool${tools.length === 1 ? '' : 's'}${tools.length ? `: ${tools.join(', ')}` : ''}`,
      });
    } catch (err) {
      setTest({ ok: false, text: failure(err) });
    } finally {
      setBusy(null);
    }
  }

  function remove() {
    if (!current || !confirm(`Delete the "${current.name}" context?${usedBy.length ? ` It's detached from ${usedBy.join(', ')}.` : ''}`)) return;
    api.removeContext(current.id).then(onClose, (err) => onError(failure(err)));
  }

  return (
    <div className="modal-backdrop stacked" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-narrow" role="dialog" aria-modal="true" aria-labelledby="context-title">
        <header className="modal-head">
          <h2 id="context-title">{context ? 'Edit context' : 'Add context'}</h2>
          <button className="ghost" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </header>
        <div className="modal-body ctx-form-stack">
          {!context && (
            <details className="ctx-card ctx-paste" open={pasting} onToggle={(e) => setPasting(e.currentTarget.open)}>
              <summary>Paste a JSON config</summary>
              <textarea rows={5} className="mono" aria-label="MCP server JSON" value={pasted} onChange={(e) => setPasted(e.target.value)}
                placeholder={'{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] } } }'} />
              {pasteError && <p className="error-text" role="alert">{pasteError}</p>}
              <button className="secondary small" disabled={!pasted.trim()} onClick={fillFromJson}>Fill in from JSON</button>
            </details>
          )}
          <Card>
            <label className="field">
              <span className="field-label">Name</span>
              <input className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="Context name" autoFocus={!context} />
            </label>
            <span className="field-hint">Letters, digits, - and _.{transport === 'folder' ? '' : ` Agents see its tools as mcp__${name || 'name'}__…`}</span>
          </Card>
          <div className="segmented" role="group" aria-label="Transport">
            <button aria-pressed={transport === 'stdio'} onClick={() => setTransport('stdio')}>STDIO</button>
            <button aria-pressed={transport === 'http'} onClick={() => setTransport('http')}>Streamable HTTP</button>
            <button aria-pressed={transport === 'folder'} onClick={() => setTransport('folder')}>Local Folder</button>
          </div>
          {transport === 'folder' ? <>
            <Card>
              <label className="field-label" htmlFor="context-folder">Folder</label>
              <div className="path-row">
                <input id="context-folder" className="mono" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="~/code/project/.agents" aria-describedby="context-folder-hint" />
                <button className="secondary small" disabled={folders.busy} onClick={() => folders.choose(folder, 'Choose the knowledge folder')}>{folders.busy ? 'Choosing…' : 'Choose…'}</button>
              </div>
              <span className="field-hint" id="context-folder-hint">
                Agents start from its AGENTS.md or CONTEXT.md (also found under .agents/), which goes into their instructions, and open the files it links to when they need them. No server runs, and it works with every provider. Agents only read it, so every role gets it.
              </span>
            </Card>
          </> : transport === 'stdio' ? <>
            <Card>
              <label className="field">
                <span className="field-label">Command to launch</span>
                <input className="mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
              </label>
            </Card>
            <Card title="Arguments">
              <ValueRows rows={args} onChange={setArgs} placeholder="Argument" label="Argument" add="Add argument" />
            </Card>
            <Card title="Environment variables">
              <PairRows rows={env} onChange={setEnv} names={['Key', 'Value']} secret add="Add environment variable" />
              <span className="field-hint">Values are encrypted on this machine and never shown again.</span>
            </Card>
            <Card title="Environment variable passthrough">
              <ValueRows rows={passthrough} onChange={setPassthrough} placeholder="VARIABLE_NAME" label="Passthrough variable" add="Add variable" />
              <span className="field-hint">Passed through from the factory's own environment when the server starts.</span>
            </Card>
            <Card>
              <label className="field">
                <span className="field-label">Working directory</span>
                <input className="mono" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~/code" />
              </label>
            </Card>
          </> : <>
            <Card>
              <label className="field">
                <span className="field-label">URL</span>
                <input className="mono" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
              </label>
            </Card>
            <Card>
              <label className="field">
                <span className="field-label">Bearer token env var</span>
                <input className="mono" value={bearer} onChange={(e) => setBearer(e.target.value)} placeholder="MCP_BEARER_TOKEN" />
              </label>
              <span className="field-hint">Read from the factory's environment and sent as the Authorization header.</span>
            </Card>
            <Card title="Headers">
              <PairRows rows={headers} onChange={setHeaders} names={['Key', 'Value']} secret add="Add header" />
              <span className="field-hint">Values are encrypted on this machine and never shown again.</span>
            </Card>
            <Card title="Headers from environment variables">
              <PairRows rows={envHeaders} onChange={setEnvHeaders} names={['Header', 'Environment variable']} add="Add variable" />
            </Card>
          </>}
          {transport !== 'folder' && <Card>
            <label className="skill-option">
              <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
              <span>
                <strong>Its tools only read</strong>
                <span className="muted small">Lets read-only roles (coordinators planning, architects reviewing, the assistant) use it too. Leave off if any tool can change things, e.g. create issues or write files.</span>
              </span>
            </label>
          </Card>}
        </div>
        {test && (
          <p className={`small context-check ctx-test ${test.ok ? 'is-ok' : 'is-bad'}`} role="status">
            <Icon name={test.ok ? 'circle-check' : 'circle-alert'} size={12} /> {test.text}
          </p>
        )}
        {folders.picker}
        <footer className="modal-foot">
          {current && <button className="danger ghost" disabled={!!busy} onClick={remove}>Delete</button>}
          <span className="spacer" />
          <button className="secondary" disabled={!!busy || !name.trim()} onClick={testConnection}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!!busy || !name.trim()} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        </footer>
      </div>
    </div>
  );
}
