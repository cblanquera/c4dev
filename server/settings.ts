/**
 * Live settings. Each project has its own settings (defaults merged with what
 * the user saved). What runs agents is chosen per agent profile.
 */
import path from 'node:path';
import * as db from './db.ts';
import { emit } from './events.ts';
import { run, shellQuote } from './shell.ts';
import { HttpError } from './errors.ts';
import type { DriverName, Project, RunLimits, Settings } from './types.ts';

export const DATA_DIR = path.resolve(process.env.FACTORY_DATA ?? '.factory');

export function defaultSettings(): Settings {
  return {
    repoPath: path.join(DATA_DIR, 'demo-repo'),
    baseBranch: 'main',
    maxActiveCards: 2,
    maxWorkers: 3,
    setupCommand: '',
    testCommand: 'npm test',
    // Defaults suit the bundled demo repo; point these at your project's tooling.
    coverageCommand: 'node --test --experimental-test-coverage',
    coverageMin: 80,
    coverageTarget: 90,
    acceptanceCommand: 'ls -R acceptance/card-{card}',
    auditLenses: [
      'Logic: simplify control flow and reduce cyclomatic complexity; remove dead code and duplication.',
      'Structure: separation of responsibility, sensible abstractions, split files that do too much.',
      'Craft: doc comments (JSDoc/Javadoc) on public APIs, helpful comments, naming, error handling, best practices, and the quality of the tests themselves.',
    ],
    maxLoops: 5,
    onComplete: 'keep',
    completeRetentionDays: 7,
    paused: false,
    team: [],
    remote: 'origin',
    budgetUsd: 0,
    budgetTokens: 0,
  };
}

export const DEFAULT_LIMITS: RunLimits = { maxTurns: 200, runMinutes: 60 };
const LIMIT_KEYS: Record<keyof RunLimits, string> = { maxTurns: 'limits.maxTurns', runMinutes: 'limits.runMinutes' };
const MAX_LIMIT = 10_000;

/** Caps on every agent run, factory-wide. */
export function runLimits(): RunLimits {
  const stored = db.loadSettings();
  const read = (key: keyof RunLimits) => {
    const value = Number(stored[LIMIT_KEYS[key]]);
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_LIMITS[key];
  };
  return { maxTurns: read('maxTurns'), runMinutes: read('runMinutes') };
}

export function setRunLimits(patch: Partial<RunLimits>): RunLimits {
  const values: Record<string, number> = {};
  for (const key of Object.keys(LIMIT_KEYS) as (keyof RunLimits)[]) {
    if (patch[key] === undefined) continue;
    const value = Number(patch[key]);
    if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) throw new HttpError(400, `Limits are whole numbers from 1 to ${MAX_LIMIT}`);
    values[LIMIT_KEYS[key]] = value;
  }
  db.saveSettings(values);
  const limits = runLimits();
  emit({ type: 'limits', limits });
  return limits;
}

/** Claude model ids to suggest; any id can still be typed. */
export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];

/** The model a provider uses when a profile picks the provider but no model. */
export function defaultModel(provider: DriverName): string {
  return provider === 'claude' ? CLAUDE_MODELS[0] : '';
}

const projects = new Map<number, Project>();

/** Keeps only known setting keys, so stale or hostile input can't add fields. */
export function pickSettings(input: Record<string, unknown>): Partial<Settings> {
  const known = Object.keys(defaultSettings());
  return Object.fromEntries(Object.entries(input).filter(([k]) => known.includes(k))) as Partial<Settings>;
}

/**
 * Loads every project. A database from before projects existed becomes the
 * first project, keeping its settings and cards.
 */
export function initSettings(): void {
  projects.clear();
  const stored = db.loadSettings();
  if (!db.listProjectRows().length) {
    const legacy = pickSettings(stored);
    const repoPath = legacy.repoPath ?? defaultSettings().repoPath;
    const id = db.insertProject(repoPath === defaultSettings().repoPath ? 'Demo project' : path.basename(repoPath), legacy);
    db.adoptOrphanCards(id);
  }
  for (const row of db.listProjectRows()) {
    projects.set(row.id, { id: row.id, name: row.name, createdAt: row.createdAt, settings: { ...defaultSettings(), ...row.settings }, remoteUrl: null });
  }
}

export function listProjects(): Project[] {
  return [...projects.values()];
}

export function getProject(id: number): Project | undefined {
  return projects.get(id);
}

/** A project's live settings. */
export function settings(projectId: number): Settings {
  const project = projects.get(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  return project.settings;
}

export function createProject(name: string, patch: Partial<Settings>): Project {
  const full = { ...defaultSettings(), ...patch };
  const id = db.insertProject(name, full);
  const project: Project = { id, name, settings: full, createdAt: Date.now(), remoteUrl: null };
  projects.set(id, project);
  emit({ type: 'project', project });
  return project;
}

export function updateProject(id: number, patch: { name?: string; settings?: Partial<Settings> }): Project {
  const current = projects.get(id);
  if (!current) throw new Error(`Project ${id} not found`);
  const next: Project = { ...current, name: patch.name ?? current.name, settings: { ...current.settings, ...patch.settings } };
  db.updateProjectRow(id, next.name, next.settings);
  projects.set(id, next);
  emit({ type: 'project', project: next });
  return next;
}

/**
 * Looks up the project's remote URL. Pull and push are only offered when the
 * repository actually has the configured remote.
 */
export async function refreshRemote(projectId: number): Promise<Project | undefined> {
  const project = projects.get(projectId);
  if (!project) return undefined;
  const { remote, repoPath } = project.settings;
  const res = remote.trim() ? await run(`git remote get-url ${shellQuote(remote.trim())}`, { cwd: repoPath }).catch(() => null) : null;
  const remoteUrl = res?.code === 0 ? res.output.trim() || null : null;
  const current = projects.get(projectId);
  if (!current || current.remoteUrl === remoteUrl) return current;
  const next = { ...current, remoteUrl };
  projects.set(projectId, next);
  emit({ type: 'project', project: next });
  return next;
}

export function updateSettings(projectId: number, patch: Partial<Settings>): Settings {
  return updateProject(projectId, { settings: patch }).settings;
}
