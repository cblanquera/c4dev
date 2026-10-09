/**
 * SQLite persistence (node:sqlite). Every mutation emits a FactoryEvent so
 * connected clients stay in sync without polling.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { emit } from './events.ts';
import type {
  Card, Comment, CommentAuthor, CommentKind, LogEntry, LogLevel, Settings, Stage, Subtask,
  SubtaskKind,
} from './types.ts';

type Row = Record<string, any>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  instructions_hash TEXT,
  stage TEXT NOT NULL DEFAULT 'icebox',
  position REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'idle',
  status_text TEXT NOT NULL DEFAULT '',
  parent_id INTEGER,
  branch TEXT,
  worktree TEXT,
  loops INTEGER NOT NULL DEFAULT 0,
  coverage REAL,
  acceptance_ready INTEGER NOT NULL DEFAULT 0,
  deliverable_kind TEXT,
  resume_stage TEXT,
  secrets TEXT NOT NULL DEFAULT '{}',
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  stage_changed_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS subtasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'build',
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  done_when TEXT NOT NULL DEFAULT '',
  depends_on TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  worker TEXT,
  branch TEXT,
  worktree TEXT,
  summary TEXT NOT NULL DEFAULT '',
  diff TEXT NOT NULL DEFAULT '',
  files TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  subtask_id INTEGER,
  actor TEXT NOT NULL,
  level TEXT NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_card ON logs(card_id);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let db: DatabaseSync;

export function openDb(file: string): void {
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
}

export function closeDb(): void {
  db?.close();
}

const now = () => Date.now();

export function hashText(text: string): string {
  return createHash('sha1').update(text.trim()).digest('hex').slice(0, 12);
}

/** Card references look like `#12`. */
export function parseTags(markdown: string, selfId?: number): number[] {
  const ids = new Set<number>();
  for (const m of markdown.matchAll(/(?<![\w&/])(?<!\]\()#(\d+)\b/g)) {
    const id = Number(m[1]);
    if (id !== selfId) ids.add(id);
  }
  return [...ids];
}

/** First heading or first non-empty line, stripped of markdown noise. */
export function deriveTitle(markdown: string): string {
  const line = markdown.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('!['));
  if (!line) return 'Untitled task';
  const clean = line.replace(/^#+\s*/, '').replace(/[*_`>]/g, '').trim();
  return clean.length > 90 ? `${clean.slice(0, 87)}…` : clean || 'Untitled task';
}

// ---------------------------------------------------------------- cards

function toCard(r: Row): Card {
  return {
    id: r.id,
    title: deriveTitle(r.description),
    description: r.description,
    instructions: r.instructions,
    instructionsHash: r.instructions_hash,
    instructionsCurrent: !!r.instructions && r.instructions_hash === hashText(r.description),
    stage: r.stage,
    position: r.position,
    status: r.status,
    statusText: r.status_text,
    tags: parseTags(r.description, r.id),
    parentId: r.parent_id,
    branch: r.branch,
    worktree: r.worktree,
    loops: r.loops,
    coverage: r.coverage,
    acceptanceReady: !!r.acceptance_ready,
    deliverableKind: r.deliverable_kind,
    resumeStage: r.resume_stage,
    secretNames: Object.keys(JSON.parse(r.secrets)),
    hidden: !!r.hidden,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    stageChangedAt: r.stage_changed_at,
    completedAt: r.completed_at,
  };
}

export function listCards(): Card[] {
  return (db.prepare('SELECT * FROM cards ORDER BY stage, position').all() as Row[]).map(toCard);
}

export function getCard(id: number): Card | undefined {
  const r = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Row | undefined;
  return r && toCard(r);
}

export function cardsInStage(stage: Stage): Card[] {
  return (db.prepare('SELECT * FROM cards WHERE stage = ? ORDER BY position').all(stage) as Row[]).map(toCard);
}

function edgePosition(stage: Stage, edge: 'top' | 'bottom'): number {
  const r = db
    .prepare(`SELECT ${edge === 'top' ? 'MIN' : 'MAX'}(position) AS p FROM cards WHERE stage = ?`)
    .get(stage) as Row;
  if (r.p == null) return 0;
  return edge === 'top' ? r.p - 1 : r.p + 1;
}

export function createCard(input: { description: string; instructions: string; instructionsHash: string | null; parentId?: number | null }): Card {
  const t = now();
  const res = db
    .prepare(
      `INSERT INTO cards (description, instructions, instructions_hash, stage, position, parent_id, created_at, updated_at, stage_changed_at)
       VALUES (?, ?, ?, 'icebox', ?, ?, ?, ?, ?)`,
    )
    .run(input.description, input.instructions, input.instructionsHash, edgePosition('icebox', 'top'), input.parentId ?? null, t, t, t);
  return publishCard(Number(res.lastInsertRowid))!;
}

const CARD_COLUMNS: Record<string, string> = {
  description: 'description',
  instructions: 'instructions',
  instructionsHash: 'instructions_hash',
  status: 'status',
  statusText: 'status_text',
  branch: 'branch',
  worktree: 'worktree',
  loops: 'loops',
  coverage: 'coverage',
  acceptanceReady: 'acceptance_ready',
  deliverableKind: 'deliverable_kind',
  resumeStage: 'resume_stage',
  hidden: 'hidden',
  position: 'position',
};

export type CardPatch = Partial<Pick<Card, 'description' | 'instructions' | 'instructionsHash' | 'status' | 'statusText' | 'branch' | 'worktree' | 'loops' | 'coverage' | 'acceptanceReady' | 'deliverableKind' | 'resumeStage' | 'hidden' | 'position'>>;

export function updateCard(id: number, patch: CardPatch): Card | undefined {
  const sets: string[] = [];
  const values: any[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const col = CARD_COLUMNS[key];
    if (!col) continue;
    sets.push(`${col} = ?`);
    values.push(typeof value === 'boolean' ? Number(value) : value ?? null);
  }
  if (!sets.length) return getCard(id);
  db.prepare(`UPDATE cards SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
  return publishCard(id);
}

export function setStatus(id: number, status: string, statusText: string): Card | undefined {
  return updateCard(id, { status, statusText });
}

/**
 * Moves a card to a stage. `position` may be an explicit sort value, or
 * 'top'/'bottom' of the destination column.
 */
export function moveCard(id: number, stage: Stage, position: number | 'top' | 'bottom' = 'top'): Card | undefined {
  const card = getCard(id);
  if (!card) return undefined;
  const pos = typeof position === 'number' ? position : edgePosition(stage, position);
  const t = now();
  const stageChanged = card.stage !== stage;
  db.prepare(
    `UPDATE cards SET stage = ?, position = ?, updated_at = ?,
       stage_changed_at = CASE WHEN ? THEN ? ELSE stage_changed_at END,
       completed_at = CASE WHEN ? = 'complete' THEN COALESCE(completed_at, ?) ELSE NULL END
     WHERE id = ?`,
  ).run(stage, pos, t, Number(stageChanged), t, stage, t, id);
  return publishCard(id);
}

/** Positions a card between two neighbours in its column (drag & drop). */
export function positionBetween(stage: Stage, beforeId: number | null, afterId: number | null): number {
  const before = beforeId != null ? getCard(beforeId) : undefined;
  const after = afterId != null ? getCard(afterId) : undefined;
  if (before && after) return (before.position + after.position) / 2;
  if (before) return before.position + 1;
  if (after) return after.position - 1;
  return edgePosition(stage, 'bottom');
}

export function getSecrets(id: number): Record<string, string> {
  const r = db.prepare('SELECT secrets FROM cards WHERE id = ?').get(id) as Row | undefined;
  return r ? JSON.parse(r.secrets) : {};
}

export function setSecrets(id: number, secrets: Record<string, string>): void {
  const merged = { ...getSecrets(id), ...secrets };
  db.prepare('UPDATE cards SET secrets = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), now(), id);
  publishCard(id);
}

function publishCard(id: number): Card | undefined {
  const card = getCard(id);
  if (card) emit({ type: 'card', card });
  return card;
}

// ---------------------------------------------------------------- subtasks

function toSubtask(r: Row): Subtask {
  return {
    id: r.id,
    cardId: r.card_id,
    seq: r.seq,
    round: r.round,
    kind: r.kind,
    title: r.title,
    instructions: r.instructions,
    doneWhen: r.done_when,
    dependsOn: JSON.parse(r.depends_on),
    status: r.status,
    worker: r.worker,
    branch: r.branch,
    worktree: r.worktree,
    summary: r.summary,
    diff: r.diff,
    files: JSON.parse(r.files),
    attempts: r.attempts,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

export function listSubtasks(cardId: number): Subtask[] {
  return (db.prepare('SELECT * FROM subtasks WHERE card_id = ? ORDER BY seq').all(cardId) as Row[]).map(toSubtask);
}

export function getSubtask(id: number): Subtask | undefined {
  const r = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(id) as Row | undefined;
  return r && toSubtask(r);
}

export interface NewSubtask {
  kind: SubtaskKind;
  title: string;
  instructions: string;
  doneWhen?: string;
  /** Indexes into the same batch (0-based) this subtask waits for. */
  dependsOn?: number[];
}

/** Inserts a batch of subtasks for one round; batch-relative deps become ids. */
export function addSubtasks(cardId: number, round: number, batch: NewSubtask[]): Subtask[] {
  const r = db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM subtasks WHERE card_id = ?').get(cardId) as Row;
  let seq = r.s as number;
  const ids: number[] = [];
  const insert = db.prepare(
    `INSERT INTO subtasks (card_id, seq, round, kind, title, instructions, done_when, depends_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]')`,
  );
  for (const s of batch) {
    const res = insert.run(cardId, ++seq, round, s.kind, s.title, s.instructions, s.doneWhen ?? '');
    ids.push(Number(res.lastInsertRowid));
  }
  batch.forEach((s, i) => {
    const deps = (s.dependsOn ?? []).filter((d) => d >= 0 && d < ids.length && d !== i).map((d) => ids[d]);
    db.prepare('UPDATE subtasks SET depends_on = ? WHERE id = ?').run(JSON.stringify(deps), ids[i]);
  });
  return ids.map((id) => publishSubtask(id)!);
}

const SUBTASK_COLUMNS: Record<string, string> = {
  status: 'status',
  worker: 'worker',
  branch: 'branch',
  worktree: 'worktree',
  summary: 'summary',
  diff: 'diff',
  attempts: 'attempts',
  startedAt: 'started_at',
  endedAt: 'ended_at',
  instructions: 'instructions',
};

export function updateSubtask(id: number, patch: Partial<Subtask>): Subtask | undefined {
  const sets: string[] = [];
  const values: any[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'files') {
      sets.push('files = ?');
      values.push(JSON.stringify(value));
      continue;
    }
    const col = SUBTASK_COLUMNS[key];
    if (!col) continue;
    sets.push(`${col} = ?`);
    values.push(value ?? null);
  }
  if (sets.length) db.prepare(`UPDATE subtasks SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  return publishSubtask(id);
}

function publishSubtask(id: number): Subtask | undefined {
  const s = getSubtask(id);
  if (s) emit({ type: 'subtask', subtask: s });
  return s;
}

export function currentRound(cardId: number): number {
  const r = db.prepare('SELECT COALESCE(MAX(round), 0) AS r FROM subtasks WHERE card_id = ?').get(cardId) as Row;
  return r.r as number;
}

// ---------------------------------------------------------------- logs

export function addLog(cardId: number, subtaskId: number | null, actor: string, level: LogLevel, text: string): LogEntry {
  const ts = now();
  const res = db
    .prepare('INSERT INTO logs (card_id, subtask_id, actor, level, text, ts) VALUES (?, ?, ?, ?, ?, ?)')
    .run(cardId, subtaskId, actor, level, text, ts);
  const log: LogEntry = { id: Number(res.lastInsertRowid), cardId, subtaskId, actor, level, text, ts };
  emit({ type: 'log', log });
  return log;
}

export function listLogs(cardId: number, limit = 2000): LogEntry[] {
  const rows = db
    .prepare('SELECT * FROM logs WHERE card_id = ? ORDER BY id DESC LIMIT ?')
    .all(cardId, limit) as Row[];
  return rows.reverse().map((r) => ({
    id: r.id, cardId: r.card_id, subtaskId: r.subtask_id, actor: r.actor, level: r.level, text: r.text, ts: r.ts,
  }));
}

// ---------------------------------------------------------------- comments

export function addComment(cardId: number, author: CommentAuthor, kind: CommentKind, body: string): Comment {
  const ts = now();
  const res = db
    .prepare('INSERT INTO comments (card_id, author, kind, body, ts) VALUES (?, ?, ?, ?, ?)')
    .run(cardId, author, kind, body, ts);
  const comment: Comment = { id: Number(res.lastInsertRowid), cardId, author, kind, body, ts };
  emit({ type: 'comment', comment });
  return comment;
}

export function listComments(cardId: number): Comment[] {
  return (db.prepare('SELECT * FROM comments WHERE card_id = ? ORDER BY id').all(cardId) as Row[]).map((r) => ({
    id: r.id, cardId: r.card_id, author: r.author, kind: r.kind, body: r.body, ts: r.ts,
  }));
}

// ---------------------------------------------------------------- settings

export function loadSettings(defaults: Settings): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Row[];
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  return { ...defaults, ...stored };
}

export function saveSettings(patch: Partial<Settings>): void {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) stmt.run(k, JSON.stringify(v));
}

/** Remove stored credential values before publishing new conversation or handoff text. */
export function redactSecrets(cardId: number, text: string): string {
  for (const value of Object.values(getSecrets(cardId)).sort((a, b) => b.length - a.length)) {
    if (value) text = text.split(value).join('[redacted]');
  }
  return text;
}
