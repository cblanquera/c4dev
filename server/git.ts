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
import { git, run, shellQuote } from './shell.ts';
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

/** A card's worktree, on its own branch, or on `branch` (e.g. the finished card a merge card lands). */
export async function createCardWorktree(repoPath: string, baseBranch: string, cardId: number, branch = cardBranch(cardId)) {
  const dir = path.join(worktreeRoot(repoPath), `card-${cardId}`);
  await addWorktree(repoPath, dir, branch, baseBranch);
  return { branch, worktree: dir };
}

export async function createSubtaskWorktree(repoPath: string, card: Card, subtask: Subtask) {
  const branch = subtaskBranch(card.id, subtask.seq);
  const dir = path.join(worktreeRoot(repoPath), `card-${card.id}-s${subtask.seq}`);
  await addWorktree(repoPath, dir, branch, card.branch ?? cardBranch(card.id));
  return { branch, worktree: dir };
}

/**
 * Stages and commits everything; returns false when there was nothing to commit.
 * A merge in progress is always concluded, even when its resolution leaves the
 * files unchanged (every conflict resolved in this branch's favour).
 */
export async function commitAll(cwd: string, message: string): Promise<boolean> {
  await git(cwd, 'add', '-A');
  const status = await git(cwd, 'status', '--porcelain');
  const merging = (await run('git rev-parse -q --verify MERGE_HEAD', { cwd })).code === 0;
  if (!status && !merging) return false;
  await git(cwd, '-c', 'user.name=Software Factory', '-c', 'user.email=factory@localhost', 'commit', '--allow-empty', '-m', message, '--no-verify');
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

/** A branch name as a full ref; full refs (e.g. refs/remotes/origin/main) pass through. */
const fullRef = (name: string) => (name.startsWith('refs/') ? name : `refs/heads/${name}`);

/** True when `ancestor` is contained in `descendant` (branch names or full refs), false when not, null when either is missing. */
export async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean | null> {
  const res = await run(`git merge-base --is-ancestor ${shellQuote(fullRef(ancestor))} ${shellQuote(fullRef(descendant))}`, { cwd: repoPath });
  return res.code === 0 ? true : res.code === 1 ? false : null;
}

/** Commit id of a branch or ref, or null when it doesn't exist. */
export async function tipOf(repoPath: string, name: string): Promise<string | null> {
  const res = await run(`git rev-parse -q --verify ${shellQuote(`${fullRef(name)}^{commit}`)}`, { cwd: repoPath });
  return res.code === 0 ? res.output.trim() : null;
}

/** Network git must fail rather than wait on a credential prompt nobody will see. */
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
const NETWORK_TIMEOUT_MS = 120_000;

/** The remote-tracking ref for a remote's branch. */
export const remoteRef = (remote: string, branch: string) => `refs/remotes/${remote}/${branch}`;

/** Fetches one branch from the remote, using the machine's own git credentials. */
export async function fetchRemote(repoPath: string, remote: string, branch: string, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  const res = await run(`git fetch ${shellQuote(remote)} ${shellQuote(`+refs/heads/${branch}:${remoteRef(remote, branch)}`)}`,
    { cwd: repoPath, signal, env: NO_PROMPT, timeoutMs: NETWORK_TIMEOUT_MS });
  return { ok: res.code === 0, output: res.output.trim() };
}

/** Pushes the base branch without force. `rejected` means the remote moved and has to be integrated first. */
export async function pushBranch(repoPath: string, remote: string, branch: string, signal?: AbortSignal): Promise<{ ok: boolean; rejected: boolean; output: string }> {
  const res = await run(`git push ${shellQuote(remote)} ${shellQuote(`refs/heads/${branch}:refs/heads/${branch}`)}`,
    { cwd: repoPath, signal, env: NO_PROMPT, timeoutMs: NETWORK_TIMEOUT_MS });
  return { ok: res.code === 0, rejected: /\[rejected\]|non-fast-forward|fetch first/i.test(res.output), output: res.output.trim() };
}

/**
 * Moves the base branch forward to `target` (which must contain it), touching
 * the main checkout only when it has the base branch checked out and is clean.
 */
export async function fastForward(repoPath: string, baseBranch: string, target: string): Promise<PublishResult> {
  const steps: string[] = [];
  const from = await git(repoPath, 'rev-parse', fullRef(baseBranch));
  const to = await git(repoPath, 'rev-parse', `${fullRef(target)}^{commit}`);
  const head = await git(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (head === baseBranch) {
    steps.push(`$ git status --porcelain  # in the main checkout, which has ${baseBranch} checked out`);
    if (await git(repoPath, 'status', '--porcelain')) return { ok: false, moved: false, reason: 'main checkout has uncommitted changes', steps };
    const res = await run(`git merge --ff-only ${shellQuote(fullRef(target))}`, { cwd: repoPath });
    steps.push(`$ git merge --ff-only ${target}${res.code === 0 ? '' : '  # refused'}`);
    if (res.code !== 0) return { ok: false, moved: true, reason: `${baseBranch} can't fast-forward`, steps };
  } else {
    const res = await run(`git update-ref ${shellQuote(fullRef(baseBranch))} ${shellQuote(to)} ${shellQuote(from)}`, { cwd: repoPath });
    steps.push(`$ git update-ref ${fullRef(baseBranch)} ${short(to)} ${short(from)}${res.code === 0 ? '  # the main checkout is untouched' : '  # refused: the branch moved meanwhile'}`);
    if (res.code !== 0) return { ok: false, moved: true, reason: `${baseBranch} has moved`, steps };
  }
  steps.push(`# ${baseBranch}: ${short(from)} → ${short(to)}`);
  return { ok: true, moved: false, reason: '', steps };
}

export interface PublishResult {
  ok: boolean;
  /** The card branch doesn't contain the base branch (any more): update and verify it first. */
  moved: boolean;
  reason: string;
  /** Every git command run, with what it found, for the card's audit trail. */
  steps: string[];
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * Lands a verified card branch on the base branch with a merge commit whose
 * code is exactly the card branch. Only possible when the card branch already
 * contains the base branch; `moved` reports that it doesn't (any more).
 * The main checkout is used only when it has the base branch checked out, and
 * then only when clean; otherwise the branch ref moves without touching it.
 */
export async function publishToBase(repoPath: string, baseBranch: string, branch: string, message: string): Promise<PublishResult> {
  const steps: string[] = [];
  const fail = (reason: string, moved = false): PublishResult => ({ ok: false, moved, reason, steps });
  const contained = await isAncestor(repoPath, baseBranch, branch);
  const baseTip = await git(repoPath, 'rev-parse', `refs/heads/${baseBranch}`);
  const branchTip = await git(repoPath, 'rev-parse', `refs/heads/${branch}`);
  steps.push(`$ git merge-base --is-ancestor ${baseBranch} ${branch}  # ${baseBranch} at ${short(baseTip)} ${contained ? 'is' : 'is not'} in ${branch} at ${short(branchTip)}`);
  if (!contained) return fail(`${baseBranch} has moved`, true);

  const head = await git(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (head === baseBranch) {
    steps.push(`$ git status --porcelain  # in the main checkout, which has ${baseBranch} checked out`);
    if (await git(repoPath, 'status', '--porcelain')) return fail('main checkout has uncommitted changes');
    steps.push(`$ git merge --no-ff -m "${message}" ${branch}`);
    const res = await mergeBranch(repoPath, branch, message);
    if (!res.ok) return fail(`merging into ${baseBranch} failed`);
  } else {
    const tree = await git(repoPath, 'rev-parse', `refs/heads/${branch}^{tree}`);
    const commit = await git(repoPath, '-c', 'user.name=Software Factory', '-c', 'user.email=factory@localhost',
      'commit-tree', tree, '-p', baseTip, '-p', `refs/heads/${branch}`, '-m', message);
    steps.push(`$ git commit-tree ${short(tree)} -p ${short(baseTip)} -p ${branch} -m "${message}"  # merge commit ${short(commit)}, the main checkout (on ${head}) is untouched`);
    // Compare-and-swap: fails if the base branch moved since it was read.
    const res = await run(`git update-ref ${shellQuote(`refs/heads/${baseBranch}`)} ${shellQuote(commit)} ${shellQuote(baseTip)}`, { cwd: repoPath });
    steps.push(`$ git update-ref refs/heads/${baseBranch} ${short(commit)} ${short(baseTip)}${res.code === 0 ? '' : '  # refused: the branch moved meanwhile'}`);
    if (res.code !== 0) return fail(`${baseBranch} has moved`, true);
  }
  const newTip = await git(repoPath, 'rev-parse', `refs/heads/${baseBranch}`);
  steps.push(`# ${baseBranch}: ${short(baseTip)} → ${short(newTip)}`);
  return { ok: true, moved: false, reason: '', steps };
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
