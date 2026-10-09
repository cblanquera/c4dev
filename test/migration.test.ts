/** A database from before projects existed opens as one project that keeps its settings and cards. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-migrate-'));
process.env.FACTORY_DATA = dataDir;
const file = path.join(dataDir, 'factory.db');

// The schema as it was before projects.
const legacy = new DatabaseSync(file);
legacy.exec(`
CREATE TABLE cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT, description TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '',
  instructions_hash TEXT, stage TEXT NOT NULL DEFAULT 'icebox', position REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'idle', status_text TEXT NOT NULL DEFAULT '', parent_id INTEGER, branch TEXT, worktree TEXT,
  loops INTEGER NOT NULL DEFAULT 0, coverage REAL, acceptance_ready INTEGER NOT NULL DEFAULT 0, deliverable_kind TEXT,
  resume_stage TEXT, secrets TEXT NOT NULL DEFAULT '{}', hidden INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, stage_changed_at INTEGER NOT NULL, completed_at INTEGER
);
CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO cards (description, stage, created_at, updated_at, stage_changed_at) VALUES ('# Old card', 'complete', 1, 1, 1);
INSERT INTO comments (card_id, author, kind, body, ts) VALUES (1, 'user', 'input', 'hello', 1);
INSERT INTO settings (key, value) VALUES ('repoPath', '"/work/legacy-repo"'), ('testCommand', '"make test"'), ('maxLoops', '3');
`);
legacy.close();

const db = await import('../server/db.ts');
const { initSettings, listProjects, assistantSettings, updateAssistantSettings } = await import('../server/settings.ts');

test('legacy settings and cards become the first project', () => {
  db.openDb(file);
  initSettings();
  const projects = listProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, 'legacy-repo');
  assert.equal(projects[0].settings.repoPath, '/work/legacy-repo');
  assert.equal(projects[0].settings.testCommand, 'make test');
  assert.equal(projects[0].settings.maxLoops, 3);
  assert.equal(projects[0].settings.baseBranch, 'main');
  assert.equal(db.getCard(1)!.projectId, projects[0].id);
  assert.equal(db.listComments(1)[0].via, null);

  // Legacy project keys don't leak into the assistant's settings.
  assert.equal(assistantSettings().driver, 'simulated');
  updateAssistantSettings({ model: 'claude-sonnet-5-5' });
  initSettings();
  assert.equal(listProjects().length, 1);
  assert.equal(assistantSettings().model, 'claude-sonnet-5-5');
  db.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
