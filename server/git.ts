/**
 * Git worktree management.
 *
 * Each card gets a branch `factory/card-<id>` checked out in its own worktree.
 * Each subtask forks `factory/card-<id>-s<seq>` from the card branch into a
 * worktree of its own, and is merged back into the card branch when done.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './settings.ts';
import { git, run } from './shell.ts';
import type { Card, FileChange, Subtask } from './types.ts';

export const cardBranch = (cardId: number) => `factory/card-${cardId}`;
export const subtaskBranch = (cardId: number, seq: number) => `factory/card-${cardId}-s${seq}`;

/** Worktrees for different repos never collide. */
function worktreeRoot(repoPath: string): string {
  const id = createHash('sha1').update(path.resolve(repoPath)).digest('hex').slice(0, 8);
  return path.join(DATA_DIR, 'worktrees', `${path.basename(repoPath)}-${id}`);
}

export async function assertRepo(repoPath: string): Promise<void> {
  if (!fs.existsSync(repoPath)) throw new Error(`Repository path does not exist: ${repoPath}`);
  await git(repoPath, 'rev-parse', '--git-dir');
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const res = await run(`git show-ref --verify --quiet refs/heads/${branch}`, { cwd: repoPath });
  return res.code === 0;
}

async function addWorktree(repoPath: string, dir: string, branch: string, from: string): Promise<string> {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(repoPath, 'worktree', 'prune');
  if (fs.existsSync(dir)) return dir;
  if (await branchExists(repoPath, branch)) await git(repoPath, 'worktree', 'add', dir, branch);
  else await git(repoPath, 'worktree', 'add', '-b', branch, dir, from);
  return dir;
}

export async function createCardWorktree(repoPath: string, baseBranch: string, cardId: number) {
  const branch = cardBranch(cardId);
  const dir = path.join(worktreeRoot(repoPath), `card-${cardId}`);
  await addWorktree(repoPath, dir, branch, baseBranch);
  return { branch, worktree: dir };
}

export async function createSubtaskWorktree(repoPath: string, card: Card, subtask: Subtask) {
  const branch = subtaskBranch(card.id, subtask.seq);
  const dir = path.join(worktreeRoot(repoPath), `card-${card.id}-s${subtask.seq}`);
  await addWorktree(repoPath, dir, branch, cardBranch(card.id));
  return { branch, worktree: dir };
}

/** Stages and commits everything; returns false when there was nothing to commit. */
export async function commitAll(cwd: string, message: string): Promise<boolean> {
  await git(cwd, 'add', '-A');
  const status = await git(cwd, 'status', '--porcelain');
  if (!status) return false;
  await git(cwd, '-c', 'user.name=Software Factory', '-c', 'user.email=factory@localhost', 'commit', '-m', message, '--no-verify');
  return true;
}

/** Diff of a subtask branch since it forked from its card branch. */
export async function diffSinceFork(cwd: string, forkedFrom: string): Promise<{ diff: string; files: FileChange[] }> {
  const range = `${forkedFrom}...HEAD`;
  const diff = await git(cwd, 'diff', '--no-color', range);
  const numstat = await git(cwd, 'diff', '--numstat', range);
  const files = numstat
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...rest] = line.split('\t');
      return { path: rest.join('\t'), added: Number(added) || 0, removed: Number(removed) || 0 };
    });
  return { diff, files };
}

/** Merges a branch into the worktree's branch. On conflict, aborts and returns the conflict report. */
export async function mergeBranch(cwd: string, branch: string, message: string): Promise<{ ok: true } | { ok: false; output: string }> {
  const res = await run(
    `git -c user.name='Software Factory' -c user.email=factory@localhost merge --no-ff --no-edit -m '${message.replace(/'/g, '')}' ${branch}`,
    { cwd },
  );
  if (res.code === 0) return { ok: true };
  await run('git merge --abort', { cwd });
  return { ok: false, output: res.output };
}

export async function removeWorktree(repoPath: string, dir: string | null): Promise<void> {
  if (!dir) return;
  await run(`git worktree remove --force '${dir}'`, { cwd: repoPath });
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  await run('git worktree prune', { cwd: repoPath });
}

/**
 * Removes every worktree belonging to a card and parks its branches under
 * `factory/archive/` so aborted work is recoverable but out of the way.
 */
export async function archiveCard(repoPath: string, cardId: number, worktrees: (string | null)[]): Promise<string[]> {
  for (const dir of worktrees) await removeWorktree(repoPath, dir);
  const list = await git(repoPath, 'branch', '--list', `factory/card-${cardId}`, `factory/card-${cardId}-s*`, '--format=%(refname:short)');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const archived: string[] = [];
  for (const branch of list.split('\n').filter(Boolean)) {
    const target = `factory/archive/${branch.slice('factory/'.length)}-${stamp}`;
    await git(repoPath, 'branch', '-m', branch, target);
    archived.push(target);
  }
  return archived;
}

/**
 * Merges the card branch into the base branch, only when the main checkout
 * is on the base branch and clean. Never touches a dirty working tree.
 */
export async function mergeIntoBase(repoPath: string, baseBranch: string, cardId: number): Promise<string> {
  const head = await git(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (head !== baseBranch) return `Kept ${cardBranch(cardId)}: main checkout is on "${head}", not "${baseBranch}".`;
  if (await git(repoPath, 'status', '--porcelain')) return `Kept ${cardBranch(cardId)}: main checkout has uncommitted changes.`;
  const res = await mergeBranch(repoPath, cardBranch(cardId), `Merge card #${cardId}`);
  return res.ok ? `Merged ${cardBranch(cardId)} into ${baseBranch}.` : `Merge into ${baseBranch} conflicted; branch kept.\n${res.output}`;
}

/** Creates a tiny Node project so the factory works out of the box. */
export async function ensureDemoRepo(repoPath: string): Promise<void> {
  if (fs.existsSync(path.join(repoPath, '.git'))) return;
  fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repoPath, 'test'), { recursive: true });
  fs.writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({
    name: 'demo-app', private: true, type: 'module',
    scripts: { test: 'node --test' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# Demo app\n\nA sandbox repository for the software factory.\n');
  fs.writeFileSync(path.join(repoPath, 'src', 'math.js'), '/** Adds two numbers. */\nexport const add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(repoPath, 'test', 'math.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { add } from '../src/math.js';\n\ntest('add', () => assert.equal(add(1, 2), 3));\n");
  await git(repoPath, 'init', '-b', 'main');
  await commitAll(repoPath, 'Initial commit');
}
