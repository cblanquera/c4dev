/** Live settings: defaults merged with what the user saved. */
import path from 'node:path';
import { loadSettings, saveSettings } from './db.ts';
import { emit } from './events.ts';
import type { Settings } from './types.ts';

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

let current: Settings;

export function initSettings(): Settings {
  current = loadSettings(defaultSettings());
  return current;
}

export function settings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  saveSettings(patch);
  current = { ...current, ...patch };
  emit({ type: 'settings', settings: current });
  return current;
}
