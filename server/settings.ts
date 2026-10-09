/**
 * Live settings. Each project has its own settings (defaults merged with what
 * the user saved); the assistant has its own driver and model.
 */
import path from 'node:path';
import * as db from './db.ts';
import { emit } from './events.ts';
import type { AssistantSettings, Project, Settings } from './types.ts';

export const DATA_DIR = path.resolve(process.env.FACTORY_DATA ?? '.factory');

export function defaultSettings(): Settings {
  return {
    repoPath: path.join(DATA_DIR, 'demo-repo'),
    baseBranch: 'main',
    driver: 'simulated',
    model: 'claude-opus-5-5',
    seniorModel: 'claude-opus-5-5',
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
  };
}

export function defaultAssistantSettings(): AssistantSettings {
  return { driver: 'simulated', model: 'claude-opus-5-5' };
}

/** Assistant keys share the key/value table with legacy project settings, so they are prefixed. */
const ASSISTANT_PREFIX = 'assistant.';

const projects = new Map<number, Project>();
let assistant: AssistantSettings;

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
    projects.set(row.id, { id: row.id, name: row.name, createdAt: row.createdAt, settings: { ...defaultSettings(), ...row.settings } });
  }
  const saved = Object.fromEntries(Object.entries(stored)
    .filter(([k]) => k.startsWith(ASSISTANT_PREFIX))
    .map(([k, v]) => [k.slice(ASSISTANT_PREFIX.length), v]));
  assistant = { ...defaultAssistantSettings(), ...saved };
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
  const project: Project = { id, name, settings: full, createdAt: Date.now() };
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

export function updateSettings(projectId: number, patch: Partial<Settings>): Settings {
  return updateProject(projectId, { settings: patch }).settings;
}

export function assistantSettings(): AssistantSettings {
  return assistant;
}

export function updateAssistantSettings(patch: Partial<AssistantSettings>): AssistantSettings {
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => k in defaultAssistantSettings())) as Partial<AssistantSettings>;
  db.saveSettings(Object.fromEntries(Object.entries(clean).map(([k, v]) => [`${ASSISTANT_PREFIX}${k}`, v])));
  assistant = { ...assistant, ...clean };
  emit({ type: 'assistant_settings', settings: assistant });
  return assistant;
}
