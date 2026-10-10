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
CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, job TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', image_url TEXT, model TEXT NOT NULL DEFAULT '', skill_ids TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
INSERT INTO profiles (name, job, created_at) VALUES ('Casey', 'designer', 1);
INSERT INTO cards (description, stage, secrets, created_at, updated_at, stage_changed_at) VALUES ('# Old card', 'complete', '{"API_KEY":"sk-legacy-123"}', 1, 1, 1);
INSERT INTO comments (card_id, author, kind, body, ts) VALUES (1, 'user', 'input', 'hello', 1);
INSERT INTO settings (key, value) VALUES ('repoPath', '"/work/legacy-repo"'), ('testCommand', '"make test"'), ('maxLoops', '3'), ('driver', '"claude"'), ('model', '"claude-sonnet-5-5"');
`);
legacy.close();

const db = await import('../server/db.ts');
const { initSettings, listProjects } = await import('../server/settings.ts');
const { seedProfiles } = await import('../server/profiles.ts');

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
  // Designer is no longer a role: designers become workers titled Designer.
  assert.deepEqual([db.getProfile(1)!.job, db.getProfile(1)!.title], ['developer', 'Designer']);

  // Secrets are encrypted at rest; the card still knows their names and the coordinator their values.
  assert.deepEqual(db.getCard(1)!.secretNames, ['API_KEY']);
  assert.deepEqual(db.getSecrets(1), { API_KEY: 'sk-legacy-123' });
  const raw = (file: string) => {
    const conn = new DatabaseSync(file);
    try {
      return conn.prepare('SELECT secrets FROM cards WHERE id = 1').get() as { secrets: string };
    } finally {
      conn.close();
    }
  };
  assert.match(raw(file).secrets, /^enc:v1:/);
  assert.equal(fs.statSync(path.join(dataDir, 'secret.key')).mode & 0o777, 0o600);
  db.setSecrets(1, { OTHER: 'value-2' });
  assert.deepEqual([db.getCard(1)!.secretNames, db.getSecrets(1).OTHER], [['API_KEY', 'OTHER'], 'value-2']);

  // The old database was backed up before the upgrade, with its secrets encrypted too.
  const [backup] = db.listBackups();
  assert.match(backup.name, /^factory-.*-v0-before-upgrade\.db$/);
  assert.match(raw(backup.path).secrets, /^enc:v1:/);
  assert.ok(!fs.readFileSync(backup.path).includes('sk-legacy-123'));
  // Reopening an up-to-date database takes no new backup; a newer one is refused.
  db.closeDb();
  db.openDb(file);
  assert.equal(db.listBackups().length, 1);
  db.closeDb();
  const newer = new DatabaseSync(file);
  newer.exec(`PRAGMA user_version = ${db.SCHEMA_VERSION + 1}`);
  newer.close();
  assert.throws(() => db.openDb(file), /newer version of the factory/);
  const reset = new DatabaseSync(file);
  reset.exec(`PRAGMA user_version = ${db.SCHEMA_VERSION}`);
  reset.close();
  db.openDb(file);

  // Agents now choose their provider; existing ones take what their project ran on.
  seedProfiles();
  assert.deepEqual([db.getProfile(1)!.provider, db.getProfile(1)!.model], ['claude', 'claude-sonnet-5-5']);
  db.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
