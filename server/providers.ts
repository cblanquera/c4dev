/**
 * Agent providers on this machine: which CLIs are installed, which the user
 * switched on, and which models to suggest. Only providers in WORK_PROVIDERS
 * (those with a driver) can be chosen to run work.
 */
import * as db from './db.ts';
import { emit } from './events.ts';
import { run, shellQuote } from './shell.ts';
import { HttpError } from './errors.ts';
import { CLAUDE_MODELS } from './settings.ts';
import { PROVIDERS, PROVIDER_LABELS, WORK_PROVIDERS, type DriverName, type ProviderId, type ProviderStatus } from './types.ts';

const COMMANDS: Record<ProviderId, string> = { claude: 'claude', codex: 'codex', opencode: 'opencode', pi: 'pi' };
/**
 * CLI versions whose output the parsers in agents/cli.ts were checked against
 * with `npm run smoke` (and recorded in test/fixtures/providers). Claude runs
 * through the Agent SDK pinned in package-lock.json, so its CLI isn't read.
 * Update these after a smoke run passes on a new version.
 */
export const TESTED_VERSIONS: Partial<Record<ProviderId, string>> = { codex: '0.161.0', opencode: '1.18.18', pi: '0.84.2' };
/** Settings keys share the key/value table, so they're prefixed. */
const KEY = (id: ProviderId) => `provider.${id}.enabled`;
const PROBE_MS = 8_000;

let statuses: ProviderStatus[] = PROVIDERS.map((id) => ({
  id, label: PROVIDER_LABELS[id], command: COMMANDS[id], available: false, version: null, path: null,
  enabled: id === 'claude', runsWork: WORK_PROVIDERS.includes(id), models: id === 'claude' ? CLAUDE_MODELS : [],
  tested: TESTED_VERSIONS[id] ?? null, versionCheck: null,
}));

const semver = (text: string | null) => text?.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) ?? null;

/** How an installed version (e.g. "codex-cli 0.162.1") compares with the tested one. */
export function compareVersion(installed: string | null, tested: string | null): ProviderStatus['versionCheck'] {
  if (!tested || !installed) return null;
  const [a, b] = [semver(installed), semver(tested)];
  if (!a || !b) return 'unknown';
  const diff = a.map((n, i) => n - b[i]).find((d) => d !== 0) ?? 0;
  return diff === 0 ? 'tested' : diff > 0 ? 'newer' : 'older';
}

function enabledFlags(): Record<ProviderId, boolean> {
  const stored = db.loadSettings();
  return Object.fromEntries(PROVIDERS.map((id) => [id, typeof stored[KEY(id)] === 'boolean' ? stored[KEY(id)] as boolean : id === 'claude'])) as Record<ProviderId, boolean>;
}

const MAX_MODELS = 600;
const MODEL_ID = /^[\w.~-]+(?:\/[\w.:~-]+)+$/;

/** Model ids each provider can list without spending tokens: Codex's and OpenCode's catalogs, Pi's table (as provider/model). */
async function listModels(id: ProviderId): Promise<string[]> {
  if (id === 'claude') return CLAUDE_MODELS;
  if (id === 'codex') {
    const res = await run('codex debug models', { cwd: process.cwd(), timeoutMs: PROBE_MS });
    try {
      const catalog = JSON.parse(res.output.slice(res.output.indexOf('{')));
      return (catalog.models ?? []).map((m: { slug?: unknown }) => String(m.slug ?? '')).filter((s: string) => /^[\w.:-]+$/.test(s)).slice(0, MAX_MODELS);
    } catch {
      return [];
    }
  }
  if (id === 'opencode') {
    const res = await run('opencode models', { cwd: process.cwd(), timeoutMs: PROBE_MS });
    return res.code === 0 ? res.output.split('\n').map((l) => l.trim()).filter((l) => MODEL_ID.test(l)).slice(0, MAX_MODELS) : [];
  }
  if (id === 'pi') {
    const res = await run('pi --list-models', { cwd: process.cwd(), timeoutMs: PROBE_MS });
    if (res.code !== 0) return [];
    return res.output.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((cols) => cols.length >= 2)
      .map(([provider, model]) => `${provider}/${model}`).filter((m) => MODEL_ID.test(m)).slice(0, MAX_MODELS);
  }
  return [];
}

async function probe(id: ProviderId, enabled: boolean): Promise<ProviderStatus> {
  const command = COMMANDS[id];
  const where = await run(`command -v ${shellQuote(command)}`, { cwd: process.cwd(), timeoutMs: PROBE_MS });
  const path = where.code === 0 ? where.output.trim().split('\n')[0] || null : null;
  const res = path ? (await run(`${shellQuote(command)} --version`, { cwd: process.cwd(), timeoutMs: PROBE_MS })) : null;
  const version = res?.code === 0 ? res.output.trim().split('\n')[0].slice(0, 120) || null : null;
  const tested = TESTED_VERSIONS[id] ?? null;
  return {
    id, label: PROVIDER_LABELS[id], command, available: !!path, path, version,
    enabled, runsWork: WORK_PROVIDERS.includes(id), models: path ? await listModels(id) : id === 'claude' ? CLAUDE_MODELS : [],
    tested, versionCheck: compareVersion(version, tested),
  };
}

export function providerStatuses(): ProviderStatus[] {
  return statuses;
}

/** Looks for each CLI again (on start, and when the user asks). */
export async function refreshProviders(): Promise<ProviderStatus[]> {
  const flags = enabledFlags();
  statuses = await Promise.all(PROVIDERS.map((id) => probe(id, flags[id])));
  emit({ type: 'providers', providers: statuses });
  return statuses;
}

/** The agents that run on a provider, by name. */
function usersOf(id: ProviderId): string[] {
  return db.activeProfiles().filter((p) => p.provider === id).map((p) => p.name);
}

export function setProviderEnabled(id: ProviderId, enabled: boolean): ProviderStatus[] {
  const current = statuses.find((s) => s.id === id)!;
  if (enabled && !current.available) throw new HttpError(409, `${current.label} isn't installed: \`${current.command}\` wasn't found on this machine`);
  if (!enabled) {
    const users = usersOf(id);
    if (users.length) throw new HttpError(409, `${current.label} is in use by ${users.join(', ')}. Switch them to another provider first.`);
  }
  db.saveSettings({ [KEY(id)]: enabled });
  statuses = statuses.map((s) => (s.id === id ? { ...s, enabled } : s));
  emit({ type: 'providers', providers: statuses });
  return statuses;
}

/** A driver choice must be the simulation, or a provider that is switched on and can run work. */
export function assertUsable(driver: unknown): asserts driver is DriverName {
  if (driver === 'simulated') return;
  const status = statuses.find((s) => s.id === driver);
  if (!status) throw new HttpError(400, 'Unknown provider');
  if (!status.enabled) throw new HttpError(409, `${status.label} is switched off. Turn it on in Settings → Providers.`);
  if (!status.runsWork) throw new HttpError(409, `${status.label} can't run factory work yet`);
}
