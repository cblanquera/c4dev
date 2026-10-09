/**
 * The coordinator: a state machine that owns every card of one project from
 * Backlog to Complete. It decides what runs when, and delegates judgement
 * (planning, building, auditing, approval) to the project's agent driver.
 *
 *   Backlog ─plan─▶ In Progress ─all subtasks merged─▶ Verification
 *      ▲              ▲      ▲                          │ tests, coverage,
 *      │              │      └──── fix subtasks ◀───────┤ senior audit
 *      │              │                                 ▼
 *      │              └──── fix subtasks ◀───────── Acceptance ─▶ Deliverables ─▶ Complete
 *    (user)                                              └──────────────────────────▲
 */
import * as db from './db.ts';
import { emit } from './events.ts';
import { judgeCoverage, parseCoverage } from './coverage.ts';
import {
  archiveCard, assertRepo, cardBranch, commitAll, createCardWorktree, createSubtaskWorktree, diffSinceFork, isAncestor,
  mergeBranch, publishToBase, removeWorktree,
} from './git.ts';
import { run, tail } from './shell.ts';
import { settings } from './settings.ts';
import { workerPrompt } from './prompts.ts';
import { deliveryNotes } from './delivery.ts';
import type { AgentContext, Driver } from './agents/driver.ts';
import { ACTIVE_STAGES, STAGE_LABELS, type Card, type Comment, type Settings, type Stage, type Subtask } from './types.ts';

const TICK_MS = 1500;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** How often completed, unmerged branches are re-checked for merges made outside the factory. */
const MERGE_CHECK_MS = 30_000;
const MAX_SUBTASK_ATTEMPTS = 2;
const MAX_DIFF_LOG = 200_000;

class AbortError extends Error {
  constructor() {
    super('aborted');
  }
}

/** Counting semaphore for worker slots; capacity is re-read on every acquire. */
class Slots {
  private used = 0;
  private waiters: (() => void)[] = [];
  private capacity: () => number;

  constructor(capacity: () => number) {
    this.capacity = capacity;
  }

  get inUse() {
    return this.used;
  }

  async acquire(signal: AbortSignal): Promise<void> {
    while (this.used >= Math.max(1, this.capacity())) {
      if (signal.aborted) throw new AbortError();
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }
    if (signal.aborted) throw new AbortError();
    this.used++;
  }

  release(): void {
    this.used--;
    this.waiters.splice(0).forEach((w) => w());
  }

  /** Wakes waiters after capacity changes. */
  poke(): void {
    this.waiters.splice(0).forEach((w) => w());
  }
}

/** Serialises async work per key (merges into one card worktree). */
class KeyedLock {
  private tails = new Map<number, Promise<unknown>>();

  run<T>(key: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.tails.set(key, next.catch(() => {}));
    return next;
  }
}

interface Job {
  controller: AbortController;
  promise: Promise<void>;
}

/** Who acted for the user, recorded on their thread messages. */
type Via = Comment['via'];

/** Why an Icebox card can't enter the Backlog yet, or null when it can. */
export function backlogBlocker(card: Card): string | null {
  if (!card.instructions.trim()) return 'Generate agent instructions before moving to the Backlog';
  if (card.instructionsHash !== db.hashText(card.description)) {
    return 'The description changed since the instructions were generated. Regenerate them (or mark them current) first.';
  }
  return null;
}

export class Coordinator {
  readonly projectId: number;
  private jobs = new Map<number, Job>();
  private replyJobs = new Map<number, Job>();
  private slots = new Slots(() => this.cfg().maxWorkers);
  private mergeLock = new KeyedLock();
  private timer: NodeJS.Timeout | undefined;
  private mergeTimer: NodeJS.Timeout | undefined;
  private checkingMerges = false;
  /** Cards inside complete(); a merge must not start until its worktrees are cleaned up. */
  private finishing = new Set<number>();
  private workerSeq = 0;
  private stopped = false;
  /** Cards being aborted; the scheduler must not pick them up again meanwhile. */
  private aborting = new Set<number>();
  private driver: () => Driver;

  constructor(projectId: number, driver: () => Driver) {
    this.projectId = projectId;
    this.driver = driver;
  }

  private cfg(): Settings {
    return settings(this.projectId);
  }

  start(): void {
    this.recover();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.mergeTimer = setInterval(() => void this.refreshMergeStates(), MERGE_CHECK_MS);
    this.tick();
    void this.refreshMergeStates();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.mergeTimer);
    for (const job of this.jobs.values()) job.controller.abort();
    for (const job of this.replyJobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values(), ...this.replyJobs.values()].map((j) => j.promise));
  }

  isChatBusy(cardId: number): boolean {
    return this.replyJobs.has(cardId);
  }

  isBusy(cardId: number): boolean {
    return this.jobs.has(cardId);
  }

  settingsChanged(): void {
    this.slots.poke();
    this.tick();
  }

  /** Work interrupted by a restart is retried from the last stable point. */
  private recover(): void {
    for (const card of db.listCards(this.projectId)) {
      for (const s of db.listSubtasks(card.id)) {
        if (s.status === 'running') db.updateSubtask(s.id, { status: 'pending', worker: null });
      }
      if (ACTIVE_STAGES.includes(card.stage) || card.stage === 'backlog') {
        if (card.status !== 'idle') db.setStatus(card.id, 'queued', 'Resuming after restart');
      }
    }
  }

  private announce(text: string): void {
    emit({ type: 'coordinator', projectId: this.projectId, text, ts: Date.now() });
  }

  private log(card: Card | number, text: string, level: 'oneliner' | 'summary' | 'detail' = 'oneliner', subtaskId: number | null = null): void {
    db.addLog(typeof card === 'number' ? card : card.id, subtaskId, 'coordinator', level, text);
  }

  // ------------------------------------------------------------ scheduling

  tick(): void {
    const cfg = this.cfg();
    if (cfg.paused || this.stopped) return;

    const cards = db.listCards(this.projectId);
    for (const card of cards) {
      if (ACTIVE_STAGES.includes(card.stage) && !this.jobs.has(card.id)) {
        this.spawn(card.id, (signal) => this.advance(card.id, signal));
      } else if (card.stage === 'complete' && card.merging && !this.jobs.has(card.id) && !this.finishing.has(card.id)) {
        this.spawn(card.id, (signal) => this.mergeCard(card.id, signal));
      }
    }

    // Pull from the top of the backlog while there is capacity.
    const active = cards.filter((c) => ACTIVE_STAGES.includes(c.stage) || this.jobs.has(c.id)).length;
    let capacity = cfg.maxActiveCards - active;
    if (capacity <= 0) return;
    for (const card of db.cardsInStage(this.projectId, 'backlog')) {
      if (capacity <= 0) break;
      if (this.jobs.has(card.id)) continue;
      const waitingOn = this.inFlightReferences(card);
      if (waitingOn.length) {
        const text = `Waiting: referenced ${waitingOn.map((id) => `#${id}`).join(', ')} still in flight`;
        if (card.statusText !== text) db.setStatus(card.id, 'waiting', text);
        continue;
      }
      capacity--;
      this.spawn(card.id, (signal) => this.startCard(card.id, signal));
    }
  }

  /**
   * Starting a card while a card it references is still being built risks
   * conflicting edits, so referenced in-flight cards are waited on.
   */
  private inFlightReferences(card: Card): number[] {
    return card.tags.filter((id) => {
      const ref = db.getCard(id);
      return ref && (ACTIVE_STAGES.includes(ref.stage) || this.jobs.has(ref.id));
    });
  }

  private spawn(cardId: number, fn: (signal: AbortSignal) => Promise<void>): void {
    if (this.aborting.has(cardId) || this.jobs.has(cardId)) return;
    const controller = new AbortController();
    const promise = fn(controller.signal)
      .catch((err) => {
        if (controller.signal.aborted || err instanceof AbortError) return;
        this.fail(cardId, err);
      })
      .finally(() => {
        this.jobs.delete(cardId);
        if (!this.cfg().paused) setTimeout(() => this.tick(), 50);
      });
    this.jobs.set(cardId, { controller, promise });
  }

  /** Unexpected errors park the card in Deliverables for a human. */
  private fail(cardId: number, err: unknown): void {
    const card = db.getCard(cardId);
    if (!card) return;
    const message = err instanceof Error ? err.message : String(err);
    this.log(card, `Error in ${STAGE_LABELS[card.stage]}: ${message}`, 'detail');
    this.escalate(card, 'blocked', `Stuck in ${STAGE_LABELS[card.stage]}: ${message.split('\n')[0]}`,
      `I hit an error I couldn't recover from while in **${STAGE_LABELS[card.stage]}**:\n\n\`\`\`\n${tail(message, 30)}\n\`\`\`\n\nReply with guidance, or press **Resume** to retry.`);
  }

  private escalate(card: Card, kind: 'approval' | 'input' | 'blocked', statusText: string, comment: string): void {
    const resumeStage: Stage = card.stage === 'deliverables' ? (card.resumeStage ?? 'in_progress') : card.stage;
    db.updateCard(card.id, { deliverableKind: kind, resumeStage, status: kind === 'approval' ? 'review' : 'needs_input', statusText });
    db.moveCard(card.id, 'deliverables', 'top', statusText);
    db.addComment(card.id, 'coordinator', kind === 'approval' ? 'question' : 'question', comment);
    this.announce(`#${card.id} → Deliverables: ${statusText}`);
  }

  private async advance(cardId: number, signal: AbortSignal): Promise<void> {
    const card = db.getCard(cardId);
    if (!card) return;
    if (card.stage === 'in_progress') return this.runInProgress(card, signal);
    if (card.stage === 'verification') return this.runVerification(card, signal);
    if (card.stage === 'acceptance') return this.runAcceptance(card, signal);
  }

  private secretsEnv(cardId: number): Record<string, string> {
    return db.getSecrets(cardId);
  }

  private ctx(cardId: number, subtaskId: number | null, actor: string, signal: AbortSignal): AgentContext {
    return { signal, log: (level, text) => db.addLog(cardId, subtaskId, actor, level, text) };
  }

  // ------------------------------------------------------------ backlog → in progress

  private async startCard(cardId: number, signal: AbortSignal): Promise<void> {
    const cfg = this.cfg();
    let card = db.getCard(cardId)!;
    await assertRepo(cfg.repoPath);
    db.setStatus(card.id, 'planning', 'Coordinator is planning subtasks');
    this.announce(`Picked up #${card.id} from the backlog`);

    const { branch, worktree } = await createCardWorktree(cfg.repoPath, cfg.baseBranch, card.id);
    card = db.updateCard(card.id, { branch, worktree })!;
    this.log(card, `Created worktree ${worktree} on ${branch}`);
    await this.setup(card, worktree, signal);

    if (!db.listSubtasks(card.id).some((s) => s.status === 'pending')) {
      const refs = card.tags.map((id) => db.getCard(id)).filter((c): c is Card => !!c);
      const plan = await this.driver().plan({ card, references: refs, repoPath: worktree }, this.ctx(card.id, null, 'coordinator', signal));
      if (signal.aborted) throw new AbortError();
      const subtasks = db.addSubtasks(card.id, db.currentRound(card.id) + 1, plan.map((p) => ({ ...p, kind: p.kind ?? 'build' })));
      this.log(card, `Split into ${subtasks.length} subtask(s):\n${subtasks.map((s) => `${s.seq}. ${s.title}${s.dependsOn.length ? ` (after ${s.dependsOn.map((d) => `#${subtasks.find((x) => x.id === d)?.seq}`).join(', ')})` : ''}`).join('\n')}`, 'summary');
    }
    db.moveCard(card.id, 'in_progress', 'top', `planned ${plural(db.listSubtasks(card.id).filter((s) => s.status === 'pending').length, 'subtask')}`);
    db.setStatus(card.id, 'queued', 'Waiting for workers');
  }

  private async setup(card: Card, cwd: string, signal: AbortSignal): Promise<void> {
    const cmd = this.cfg().setupCommand.trim();
    if (!cmd) return;
    this.log(card, `$ ${cmd}`);
    const res = await run(cmd, { cwd, signal, env: this.secretsEnv(card.id) });
    if (signal.aborted) throw new AbortError();
    if (res.code !== 0) throw new Error(`Setup command failed (exit ${res.code}):\n${tail(res.output, 40)}`);
  }

  // ------------------------------------------------------------ in progress

  private async runInProgress(card: Card, signal: AbortSignal): Promise<void> {
    const running = new Map<number, Promise<void>>();
    const refresh = () => {
      const subs = db.listSubtasks(card.id);
      const done = subs.filter((s) => s.status === 'done').length;
      db.setStatus(card.id, running.size ? 'running' : 'queued',
        `${done}/${subs.length} subtasks done${running.size ? ` · ${running.size} worker${running.size > 1 ? 's' : ''} active` : ''}`);
    };

    try {
      await this.dispatchSubtasks(card, running, refresh, signal);
    } finally {
      // Never leave workers writing after the card has moved on (e.g. on abort).
      await Promise.allSettled(running.values());
    }
    if (signal.aborted) throw new AbortError();
    this.finishInProgress(card);
  }

  /** Starts every subtask whose dependencies are done, until nothing is left to run. */
  private async dispatchSubtasks(card: Card, running: Map<number, Promise<void>>, refresh: () => void, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) throw new AbortError();
      const subs = db.listSubtasks(card.id);
      const status = new Map(subs.map((s) => [s.id, s.status]));
      const pending = subs.filter((s) => s.status === 'pending');
      const anyBlocked = subs.some((s) => s.status === 'blocked');
      const anyFailed = subs.some((s) => s.status === 'failed');

      // Once something needs a human, let running workers finish but start nothing new.
      if (!anyBlocked && !anyFailed) {
        for (const s of pending) {
          if (running.has(s.id) || !s.dependsOn.every((d) => status.get(d) === 'done')) continue;
          running.set(s.id, this.runSubtask(card.id, s.id, signal).finally(() => {
            running.delete(s.id);
            refresh();
          }));
        }
      }
      refresh();
      if (!running.size) return;
      await Promise.race(running.values());
    }
  }

  /** Decides where a card goes once no subtask is running. */
  private finishInProgress(card: Card): void {
    const subs = db.listSubtasks(card.id);
    const current = db.getCard(card.id)!;
    const blocked = subs.filter((s) => s.status === 'blocked');
    if (blocked.length) {
      const questions = db.listComments(card.id).filter((c) => c.author === 'coordinator').slice(-blocked.length);
      return this.escalate(current, 'input', 'Waiting for your input', questions.length
        ? 'Workers are paused until you answer the questions above. Add your input (and any credentials) below, then press **Resume**.'
        : 'A worker needs input to continue.');
    }
    const failed = subs.filter((s) => s.status === 'failed');
    if (failed.length) {
      return this.escalate(current, 'blocked', `${failed.length} subtask(s) failed`,
        `These subtasks failed after ${MAX_SUBTASK_ATTEMPTS} attempts:\n\n${failed.map((s) => `- **${s.title}**: ${s.summary || 'see logs'}`).join('\n')}\n\nAdd guidance and press **Resume**, or abort the card.`);
    }
    const stuck = subs.filter((s) => s.status === 'pending');
    if (stuck.length) {
      return this.escalate(current, 'blocked', 'Subtask dependencies cannot be satisfied',
        `These subtasks wait on work that never finished: ${stuck.map((s) => s.title).join(', ')}.`);
    }

    db.moveCard(card.id, 'verification', 'top', 'all subtasks merged into the card branch');
    db.setStatus(card.id, 'queued', 'Waiting for verification');
  }

  private async runSubtask(cardId: number, subtaskId: number, signal: AbortSignal): Promise<void> {
    await this.slots.acquire(signal);
    const worker = `worker-${++this.workerSeq}`;
    let subtask = db.getSubtask(subtaskId)!;
    try {
      const cfg = this.cfg();
      const card = db.getCard(cardId)!;
      subtask = db.updateSubtask(subtask.id, { status: 'running', worker, attempts: subtask.attempts + 1, startedAt: Date.now(), endedAt: null })!;
      this.log(card, `Assigned "${subtask.title}" to ${worker}`, 'oneliner', subtask.id);

      const { branch, worktree } = await createSubtaskWorktree(cfg.repoPath, card, subtask);
      subtask = db.updateSubtask(subtask.id, { branch, worktree })!;
      await this.setup(card, worktree, signal);

      const prompt = workerPrompt(card, subtask, {
        testCommand: cfg.testCommand,
        siblings: db.listSubtasks(card.id),
        acceptanceDir: `acceptance/card-${card.id}`,
      });
      const result = await this.driver().work(
        { card, subtask, cwd: worktree, prompt, env: this.secretsEnv(card.id), model: cfg.model },
        this.ctx(card.id, subtask.id, worker, signal),
      );
      if (signal.aborted) throw new AbortError();

      await commitAll(worktree, `card #${card.id} s${subtask.seq}: ${subtask.title}`);
      const { diff, files } = await diffSinceFork(worktree, cardBranch(card.id));
      if (diff) db.addLog(card.id, subtask.id, worker, 'diff', diff.length > MAX_DIFF_LOG ? `${diff.slice(0, MAX_DIFF_LOG)}\n… diff truncated` : diff);
      db.addLog(card.id, subtask.id, worker, 'summary', result.summary || '(no summary)');
      db.updateSubtask(subtask.id, { summary: result.summary, diff, files });

      if (result.blocked) {
        db.updateSubtask(subtask.id, { status: 'blocked', endedAt: Date.now() });
        db.addComment(card.id, 'coordinator', 'question',
          `**${worker}** on "${subtask.title}" needs you:\n\n${result.blocked.question}${result.blocked.secretName ? `\n\nProvide it as the secret \`${result.blocked.secretName}\`.` : ''}`);
        return;
      }

      await this.integrate(card, subtask, signal);
      db.updateSubtask(subtask.id, { status: 'done', endedAt: Date.now() });
    } catch (err) {
      if (signal.aborted || err instanceof AbortError) {
        db.updateSubtask(subtask.id, { status: 'aborted', endedAt: Date.now() });
        throw new AbortError();
      }
      const message = err instanceof Error ? err.message : String(err);
      const latest = db.getSubtask(subtask.id)!;
      const retry = latest.attempts < MAX_SUBTASK_ATTEMPTS;
      db.addLog(cardId, subtask.id, worker, 'detail', `Attempt ${latest.attempts} failed: ${message}`);
      db.updateSubtask(subtask.id, { status: retry ? 'pending' : 'failed', summary: message.split('\n')[0], endedAt: Date.now() });
      this.log(cardId, retry ? `"${subtask.title}" failed; retrying` : `"${subtask.title}" failed for good`, 'oneliner', subtask.id);
    } finally {
      this.slots.release();
    }
  }

  /** Merges a finished subtask into the card branch; conflicts become a merge subtask. */
  private async integrate(card: Card, subtask: Subtask, signal: AbortSignal): Promise<void> {
    const cfg = this.cfg();
    const fresh = db.getSubtask(subtask.id)!;
    await this.mergeLock.run(card.id, async () => {
      if (signal.aborted) throw new AbortError();
      const result = await mergeBranch(card.worktree!, fresh.branch!, `Merge subtask ${fresh.seq}: ${fresh.title}`);
      if (result.ok) {
        this.log(card, `Merged ${fresh.branch} into ${cardBranch(card.id)}`, 'oneliner', fresh.id);
        await removeWorktree(cfg.repoPath, fresh.worktree);
        db.updateSubtask(fresh.id, { worktree: null });
        return;
      }
      this.log(card, `Merge conflict integrating ${fresh.branch}; assigning a merge subtask`, 'oneliner', fresh.id);
      db.addLog(card.id, fresh.id, 'coordinator', 'detail', tail(result.output, 60));
      db.addSubtasks(card.id, fresh.round, [{
        kind: 'merge',
        title: `Resolve conflicts merging "${fresh.title}"`,
        instructions: `Run \`git merge ${fresh.branch}\` in this worktree and resolve every conflict, keeping the intent of both sides. Leave the resolved files in place; the coordinator will conclude the merge.\n\nConflict report:\n\`\`\`\n${tail(result.output, 40)}\n\`\`\``,
        doneWhen: 'No conflict markers remain and the tests pass.',
      }]);
    });
  }

  // ------------------------------------------------------------ verification

  private async runVerification(card: Card, signal: AbortSignal): Promise<void> {
    const cfg = this.cfg();
    const cwd = card.worktree!;
    const env = this.secretsEnv(card.id);

    if (cfg.testCommand.trim()) {
      db.setStatus(card.id, 'testing', 'Running tests');
      this.log(card, `$ ${cfg.testCommand}`);
      const res = await run(cfg.testCommand, { cwd, env, signal });
      if (signal.aborted) throw new AbortError();
      db.addLog(card.id, null, 'coordinator', 'detail', `Test output (exit ${res.code}):\n${tail(res.output, 150)}`);
      if (res.code !== 0) {
        return this.backToWork(card, 'Tests failed', [{
          kind: 'fix', title: 'Fix failing tests',
          instructions: `The test suite fails (\`${cfg.testCommand}\`, exit ${res.code}). Fix the code (or the tests, if a test is wrong — say why).\n\n\`\`\`\n${tail(res.output, 80)}\n\`\`\``,
          doneWhen: `\`${cfg.testCommand}\` exits 0`,
        }]);
      }
      this.log(card, 'Tests passed');
    } else {
      this.log(card, 'No test command configured; skipping tests');
    }

    if (cfg.coverageCommand.trim()) {
      db.setStatus(card.id, 'testing', 'Measuring coverage');
      this.log(card, `$ ${cfg.coverageCommand}`);
      const res = await run(cfg.coverageCommand, { cwd, env, signal });
      if (signal.aborted) throw new AbortError();
      const pct = parseCoverage(res.output, cwd);
      db.updateCard(card.id, { coverage: pct });
      if (pct == null) {
        this.log(card, 'Could not find a coverage total in the output; continuing', 'oneliner');
        db.addLog(card.id, null, 'coordinator', 'detail', `Coverage output (exit ${res.code}):\n${tail(res.output, 80)}`);
      } else {
        const verdict = judgeCoverage(pct, cfg.coverageMin, cfg.coverageTarget);
        this.log(card, `Coverage ${pct.toFixed(1)}% (${verdict})`);
        if (verdict === 'low') {
          return this.backToWork(card, `Coverage ${pct.toFixed(1)}% is below ${cfg.coverageMin}%`, [{
            kind: 'fix', title: `Raise test coverage to ≥ ${cfg.coverageTarget}%`,
            instructions: `Line coverage is ${pct.toFixed(1)}%; the minimum is ${cfg.coverageMin}% and the target ${cfg.coverageTarget}%. Add meaningful tests for the uncovered code of this task.\n\n\`\`\`\n${tail(res.output, 60)}\n\`\`\``,
            doneWhen: `\`${cfg.coverageCommand}\` reports ≥ ${cfg.coverageTarget}% line coverage`,
          }]);
        }
      }
    }

    const findings: { title: string; detail: string; files: string[]; severity: string }[] = [];
    const lenses = cfg.auditLenses.filter((l) => l.trim());
    for (const [i, lens] of lenses.entries()) {
      db.setStatus(card.id, 'auditing', `Senior audit ${i + 1}/${lenses.length}: ${lens.split(':')[0]}`);
      const result = await this.driver().audit(
        { card: db.getCard(card.id)!, cwd, lens, baseBranch: cfg.baseBranch, model: cfg.seniorModel },
        this.ctx(card.id, null, 'senior', signal),
      );
      if (signal.aborted) throw new AbortError();
      const blocking = result.recommendations.filter((r) => r.severity !== 'nit');
      const nits = result.recommendations.filter((r) => r.severity === 'nit');
      db.addLog(card.id, null, 'senior', 'summary',
        `Pass ${i + 1} (${lens.split(':')[0]}): ${blocking.length ? `${blocking.length} recommendation(s)` : 'approved'}. ${result.summary}`);
      if (result.recommendations.length) {
        db.addLog(card.id, null, 'senior', 'detail', result.recommendations
          .map((r) => `[${r.severity}] ${r.title}${r.files.length ? ` (${r.files.join(', ')})` : ''}\n${r.detail}`).join('\n\n'));
      }
      if (nits.length) this.log(card, `${nits.length} nit(s) noted, not blocking`);
      findings.push(...blocking);
    }

    if (findings.length) {
      // One fix subtask per area of the code keeps workers from colliding.
      const groups = new Map<string, typeof findings>();
      for (const f of findings) {
        const key = f.files[0]?.split('/').slice(0, -1).join('/') || f.files[0] || 'general';
        groups.set(key, [...(groups.get(key) ?? []), f]);
      }
      return this.backToWork(card, `Senior audit raised ${findings.length} recommendation(s)`, [...groups.values()].slice(0, 6).map((group) => ({
        kind: 'fix' as const,
        title: group.length === 1 ? group[0].title : `${group.length} audit fixes in ${group[0].files[0] ?? 'the code'}`,
        instructions: `Address these senior review recommendations:\n\n${group.map((f) => `- **[${f.severity}] ${f.title}**${f.files.length ? ` — ${f.files.join(', ')}` : ''}\n  ${f.detail}`).join('\n')}`,
        doneWhen: 'Each recommendation is addressed and the tests pass.',
      })));
    }

    db.moveCard(card.id, 'acceptance', 'top', 'tests, coverage and senior audit passed');
    db.setStatus(card.id, 'queued', 'Waiting for acceptance');
  }

  /** Sends a card back to In Progress with fix subtasks, or escalates after too many loops. */
  private backToWork(card: Card, reason: string, fixes: db.NewSubtask[]): void {
    const cfg = this.cfg();
    const loops = card.loops + 1;
    db.updateCard(card.id, { loops });
    if (loops > cfg.maxLoops) {
      const current = db.getCard(card.id)!;
      this.escalate(current, 'blocked', `Still failing after ${cfg.maxLoops} loops: ${reason}`,
        `I've sent this back to the workers ${cfg.maxLoops} times and it still doesn't pass (${reason}). It may need a clearer spec or a decision from you. Reply with guidance and press **Resume**, or abort.`);
      return;
    }
    db.addSubtasks(card.id, db.currentRound(card.id) + 1, fixes);
    this.announce(`#${card.id} back to In Progress: ${reason}`);
    db.moveCard(card.id, 'in_progress', 'top', `${reason}; loop ${loops}/${cfg.maxLoops} with ${plural(fixes.length, 'fix subtask')}`);
    db.setStatus(card.id, 'queued', reason);
  }

  // ------------------------------------------------------------ acceptance

  private async runAcceptance(card: Card, signal: AbortSignal): Promise<void> {
    const cfg = this.cfg();

    if (!card.acceptanceReady) {
      db.setStatus(card.id, 'running', 'Writing acceptance scripts');
      let script = db.listSubtasks(card.id).find((s) => s.kind === 'acceptance' && s.status !== 'aborted');
      if (!script) {
        [script] = db.addSubtasks(card.id, db.currentRound(card.id) + 1, [{
          kind: 'acceptance',
          title: 'Write acceptance scripts',
          instructions: 'Write acceptance tests for this task from its acceptance criteria and test plan.',
          doneWhen: `Acceptance specs exist under acceptance/card-${card.id}/<journey>/<use-case>, covering visuals and a mobile viewport.`,
        }]);
      }
      if (script.status === 'pending') await this.runSubtask(card.id, script.id, signal);
      if (signal.aborted) throw new AbortError();
      const after = db.getSubtask(script.id)!;
      if (after.status === 'blocked') return this.escalate(db.getCard(card.id)!, 'input', 'Waiting for your input', 'The acceptance worker needs input; see the question above.');
      if (after.status === 'pending') return; // retry on next tick
      if (after.status !== 'done') throw new Error(`Writing acceptance scripts failed: ${after.summary}`);
      db.updateCard(card.id, { acceptanceReady: true });
    }

    const command = cfg.acceptanceCommand.replaceAll('{card}', String(card.id)).trim();
    if (command) {
      db.setStatus(card.id, 'testing', 'Running acceptance tests');
      this.log(card, `$ ${command}`);
      const res = await run(command, { cwd: card.worktree!, env: this.secretsEnv(card.id), signal });
      if (signal.aborted) throw new AbortError();
      db.addLog(card.id, null, 'coordinator', 'detail', `Acceptance output (exit ${res.code}):\n${tail(res.output, 150)}`);
      if (res.code !== 0) {
        return this.backToWork(db.getCard(card.id)!, 'Acceptance tests failed', [{
          kind: 'fix', title: 'Make acceptance tests pass',
          instructions: `Acceptance tests fail (\`${command}\`, exit ${res.code}). Fix the application so the user journeys work. Only change an acceptance script if it is genuinely wrong, and explain why.\n\n\`\`\`\n${tail(res.output, 80)}\n\`\`\``,
          doneWhen: `\`${command}\` exits 0`,
        }]);
      }
      this.log(card, 'Acceptance tests passed');
    } else {
      this.log(card, 'No acceptance command configured; scripts written but not run');
    }

    // A merge pass was already reviewed and approved as work; it only had to pass again with the new base.
    if (db.getCard(card.id)!.merging) return this.complete(card.id, `the update from ${cfg.baseBranch} passed verification and acceptance`);

    db.setStatus(card.id, 'deciding', 'Preparing your review instructions');
    const verification = db.listLogs(card.id).filter((l) => /^(Tests passed|Acceptance tests passed|Coverage \d|No acceptance command)/.test(l.text)).map((l) => l.text).join('\n');
    const notes = await this.driver().handoff(
      { card: db.getCard(card.id)!, subtasks: db.listSubtasks(card.id), cwd: card.worktree!, verification },
      this.ctx(card.id, null, 'coordinator', signal),
    );
    if (signal.aborted) throw new AbortError();
    db.addComment(card.id, 'coordinator', 'handoff', db.redactSecrets(card.id, notes));

    db.setStatus(card.id, 'deciding', 'Deciding whether this needs your approval');
    const decision = await this.driver().decideApproval(
      { card: db.getCard(card.id)!, subtasks: db.listSubtasks(card.id) },
      this.ctx(card.id, null, 'coordinator', signal),
    );
    if (signal.aborted) throw new AbortError();
    this.log(card, `Approval needed: ${decision.needsApproval ? 'yes' : 'no'}. ${decision.reason}`, 'summary');
    if (decision.needsApproval) {
      const questions = decision.questions.map((q) => `- ${q}`).join('\n');
      return this.escalate(db.getCard(card.id)!, decision.kind, decision.kind === 'input' ? 'Needs your input' : 'Ready for your approval',
        `${decision.reason}${questions ? `\n\n${questions}` : ''}\n\nApprove to complete, or tell me what to change.`);
    }
    await this.complete(card.id, 'acceptance passed and no human review is needed');
  }

  private async complete(cardId: number, reason: string): Promise<void> {
    const cfg = this.cfg();
    const card = db.getCard(cardId)!;
    const branch = card.branch ?? cardBranch(card.id);
    this.finishing.add(card.id);
    try {
      // Settled before the move, so whoever hears about the completion also hears where the work went.
      const merge = card.merging ? {} : await this.mergeOnComplete(card, branch);
      const merging = card.merging || merge.merging === true;
      db.updateCard(card.id, { deliverableKind: null, resumeStage: null, ...merge });
      db.moveCard(card.id, 'complete', 'top', reason);
      db.setStatus(card.id, merging ? 'merging' : 'done', merging ? `Merging into ${cfg.baseBranch}…` : `Done on ${branch}`);
      for (const s of db.listSubtasks(card.id)) if (s.worktree) await removeWorktree(cfg.repoPath, s.worktree);
      await removeWorktree(cfg.repoPath, card.worktree);
      db.updateCard(card.id, { worktree: null });
      this.announce(`#${card.id} complete`);
    } finally {
      this.finishing.delete(card.id);
    }
    if (db.getCard(card.id)?.merging) this.tick();
  }

  /** "Merge into base branch" projects land work straight away, or start a merge when the base has moved. */
  private async mergeOnComplete(card: Card, branch: string): Promise<db.CardPatch> {
    const cfg = this.cfg();
    if (cfg.onComplete !== 'merge') return { mergeState: 'unmerged', mergeNote: `Kept on ${branch}` };
    return (await this.publish(card, branch))
      ?? { mergeState: 'unmerged', mergeNote: `Updating with ${cfg.baseBranch} before merging`, merging: true };
  }

  /**
   * Lands a verified branch on the base branch. Returns null when the base has
   * moved since, so the branch must be updated and verified again first.
   */
  private async publish(card: Card, branch: string): Promise<db.CardPatch | null> {
    const cfg = this.cfg();
    const base = cfg.baseBranch;
    let reason: string;
    let steps: string[] = [];
    try {
      const result = await publishToBase(cfg.repoPath, base, branch, `Merge card #${card.id}: ${card.title}`);
      steps = result.steps;
      if (result.ok) {
        this.log(card, `Merged ${branch} into ${base}. It was verified against this exact ${base}, so nothing new reached ${base} untested.`, 'summary');
        this.log(card, steps.join('\n'), 'detail');
        return { mergeState: 'merged', mergeNote: `Merged into ${base}`, merging: false };
      }
      if (result.moved) {
        this.log(card, `${base} has moved since ${branch} was verified, so the branch is brought up to date and verified again before merging.`, 'summary');
        this.log(card, steps.join('\n'), 'detail');
        return null;
      }
      reason = result.reason;
    } catch (err) {
      reason = (err instanceof Error ? err.message : String(err)).split('\n')[0];
    }
    this.log(card, `Kept ${branch}: ${reason}.`, 'summary');
    if (steps.length) this.log(card, steps.join('\n'), 'detail');
    return { mergeState: 'blocked', mergeNote: `Kept on ${branch}: ${reason}`, merging: false };
  }

  /**
   * Merge button and assistant: land a completed card on the base branch. If
   * the base has moved, the card goes back through verification first, so only
   * verified code reaches it.
   */
  requestMerge(cardId: number, via: Via = null): Card {
    const cfg = this.cfg();
    const card = this.mustBeIn(cardId, ['complete']);
    if (card.hidden) throw new HttpError(409, `Card #${card.id} is hidden`);
    if (!card.branch) throw new HttpError(409, `Card #${card.id} has no branch to merge`);
    if (card.mergeState === 'merged') throw new HttpError(409, `Card #${card.id} is already merged into ${cfg.baseBranch}`);
    if (card.merging || this.jobs.has(card.id)) throw new HttpError(409, `Card #${card.id} is already being merged`);
    // A merge gets its own loop budget.
    db.updateCard(card.id, { merging: true, loops: 0 });
    db.setStatus(card.id, 'merging', cfg.paused ? 'Waiting to merge: coordinator paused' : `Merging into ${cfg.baseBranch}…`);
    this.log(card, `You asked to merge ${card.branch} into ${cfg.baseBranch}${via === 'assistant' ? ', through the assistant' : ''}.`, 'summary');
    this.tick();
    return db.getCard(card.id)!;
  }

  /** Lands a requested merge, or brings the branch up to date and sends it back through verification. */
  private async mergeCard(cardId: number, signal: AbortSignal): Promise<void> {
    const cfg = this.cfg();
    let card = db.getCard(cardId)!;
    if (card.stage !== 'complete' || !card.merging || !card.branch) return;
    const branch = card.branch;
    const base = cfg.baseBranch;
    try {
      db.setStatus(card.id, 'merging', `Merging into ${base}…`);
      const landed = await this.publish(card, branch);
      if (signal.aborted) throw new AbortError();
      if (landed) {
        db.updateCard(card.id, landed);
        db.setStatus(card.id, 'done', landed.mergeState === 'merged' ? `Done · merged into ${base}` : `Done on ${branch}`);
        if (landed.mergeState === 'merged') this.announce(`#${card.id} merged into ${base}`);
        return;
      }

      // The base moved since this branch was verified: update the branch, then verify the combination.
      const loops = card.loops + 1;
      if (loops > cfg.maxLoops) {
        db.updateCard(card.id, { merging: false, mergeState: 'blocked', mergeNote: `Kept on ${branch}: ${base} kept moving during ${cfg.maxLoops} merge attempts` });
        db.setStatus(card.id, 'done', `Done on ${branch}`);
        return;
      }
      await assertRepo(cfg.repoPath);
      const { worktree } = await createCardWorktree(cfg.repoPath, base, card.id);
      card = db.updateCard(card.id, { worktree, loops })!;
      this.log(card, `Created worktree ${worktree} on ${branch}`);
      await this.setup(card, worktree, signal);
      this.log(card, `$ git merge --no-ff ${base}`);
      const result = await mergeBranch(worktree, base, `Merge ${base} into card #${card.id}`);
      if (signal.aborted) throw new AbortError();
      if (result.ok) {
        db.moveCard(card.id, 'verification', 'top', `merged ${base} into ${branch} without conflicts (merge attempt ${loops}/${cfg.maxLoops}); verifying the combination`);
        db.setStatus(card.id, 'queued', `Verifying the merge with ${base}`);
        return;
      }
      const conflicts = [...result.output.matchAll(/CONFLICT \([^)]*\): .*? in (\S+)/g)].map((m) => m[1]);
      db.moveCard(card.id, 'in_progress', 'top', `${base} conflicts with ${branch}${conflicts.length ? ` in ${conflicts.map((f) => `\`${f}\``).join(', ')}` : ''} (merge attempt ${loops}/${cfg.maxLoops}); a worker resolves them`);
      this.log(card, `$ git merge --no-ff ${base}\n${tail(result.output, 60)}\n$ git merge --abort`, 'detail');
      db.addSubtasks(card.id, db.currentRound(card.id) + 1, [{
        kind: 'merge',
        title: `Resolve conflicts with ${base}`,
        instructions: `Run \`git merge ${base}\` in this worktree and resolve every conflict, keeping this task's changes and everything ${base} gained since. Leave the resolved files in place; the coordinator will conclude the merge.\n\nConflict report:\n\`\`\`\n${tail(result.output, 40)}\n\`\`\``,
        doneWhen: 'No conflict markers remain and the tests pass.',
      }]);
      db.setStatus(card.id, 'queued', `Resolving conflicts with ${base}`);
    } catch (err) {
      if (signal.aborted || err instanceof AbortError) throw err;
      // Problems before the card re-enters the pipeline stop the merge; the completed work is untouched.
      const reason = (err instanceof Error ? err.message : String(err)).split('\n')[0];
      const current = db.getCard(card.id)!;
      if (current.worktree) await removeWorktree(cfg.repoPath, current.worktree).catch(() => {});
      db.updateCard(card.id, { merging: false, worktree: null, mergeState: 'blocked', mergeNote: `Kept on ${branch}: ${reason}` });
      db.setStatus(card.id, 'done', `Done on ${branch}`);
      this.log(card, `Merge stopped: ${reason}`, 'detail');
    }
  }

  /**
   * Completed branches merged by hand outside the factory are marked merged;
   * completed cards from before merge states existed get one.
   */
  async refreshMergeStates(): Promise<void> {
    if (this.checkingMerges || this.stopped) return;
    this.checkingMerges = true;
    try {
      const cfg = this.cfg();
      for (const card of db.listCards(this.projectId)) {
        if (card.stage !== 'complete' || !card.branch || card.merging || card.mergeState === 'merged') continue;
        const merged = await isAncestor(cfg.repoPath, card.branch, cfg.baseBranch).catch(() => null);
        const fresh = db.getCard(card.id);
        if (this.stopped || !fresh || fresh.stage !== 'complete' || fresh.merging) continue;
        if (merged) {
          db.updateCard(card.id, { mergeState: 'merged', mergeNote: `Merged into ${cfg.baseBranch}` });
          this.log(card, `Found ${card.branch} merged into ${cfg.baseBranch} outside the factory.`, 'summary');
        }
        else if (!fresh.mergeState) {
          db.updateCard(card.id, { mergeState: 'unmerged', mergeNote: merged === false ? `Kept on ${card.branch}` : `Branch ${card.branch} no longer exists` });
        }
      }
    } finally {
      this.checkingMerges = false;
    }
  }

  // ------------------------------------------------------------ deliverables (human in the loop)

  async approve(cardId: number, note: string, via: Via = null): Promise<void> {
    const card = this.mustBeIn(cardId, ['deliverables']);
    this.cancelReply(card.id);
    db.addComment(card.id, 'user', 'approval', note || 'Approved.', via);
    await this.complete(card.id, via === 'assistant' ? 'approved by you, through the assistant' : 'approved by you');
  }

  /** Explicit "send back": no pushback, the user's word goes. */
  requestChanges(cardId: number, body: string, via: Via = null): void {
    const card = this.mustBeIn(cardId, ['deliverables']);
    this.cancelReply(card.id);
    db.addComment(card.id, 'user', 'changes', body, via);
    this.resume(card, body);
  }

  /** Resume button: retry / continue with whatever input is in the thread. */
  resumeFromDeliverables(cardId: number, body = '', secrets: Record<string, string> = {}, via: Via = null): void {
    const card = this.mustBeIn(cardId, ['deliverables']);
    this.cancelReply(card.id);
    this.storeInput(card.id, body, secrets, via);
    const input = db.listComments(card.id).filter((c) => c.author === 'user' && c.ts > card.stageChangedAt).map((c) => c.body).join('\n\n');
    this.resume(card, input);
  }

  /** Stop a pending reply before an explicit lifecycle action or replacement message. */
  private cancelReply(cardId: number): void {
    this.replyJobs.get(cardId)?.controller.abort();
  }

  /**
   * An explicit request to start an Icebox card: queues it at the bottom of
   * the Backlog under the same rules as a manual move.
   */
  enqueue(cardId: number): Card {
    const card = this.mustBeIn(cardId, ['icebox']);
    if (card.hidden) throw new HttpError(409, `Card #${card.id} is deleted`);
    const blocker = backlogBlocker(card);
    if (blocker) throw new HttpError(409, blocker);
    db.moveCard(card.id, 'backlog', 'bottom', 'queued by the assistant at your request');
    db.setStatus(card.id, 'queued', 'Queued for the coordinator');
    this.tick();
    return db.getCard(card.id)!;
  }

  /** Chat never queues new work or changes an active card's scheduler status. */
  comment(cardId: number, body: string, secrets: Record<string, string>, via: Via = null): void {
    const card = this.mustBeIn(cardId, ['backlog', 'in_progress', 'verification', 'acceptance', 'deliverables', 'complete']);
    if (card.hidden || this.aborting.has(cardId) || this.stopped) throw new HttpError(409, 'This card is not available for conversation');
    if (Object.keys(secrets).length && card.stage !== 'deliverables') throw new HttpError(409, 'Secrets can only be provided in Deliverables');
    this.storeInput(card.id, body, secrets, via);
    this.cancelReply(card.id);
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      const fresh = db.getCard(card.id)!;
      const subtasks = db.listSubtasks(card.id);
      const comments = db.listComments(card.id);
      const reply = await this.driver().reply(
        { card: fresh, thread: comments, subtasks, repoPath: this.cfg().repoPath,
          deliveryNotes: deliveryNotes(fresh, subtasks, db.listLogs(card.id), comments, this.cfg()) },
        this.ctx(card.id, null, 'coordinator', controller.signal),
      );
      controller.signal.throwIfAborted();
      const current = db.getCard(card.id);
      if (!current || current.hidden || current.stage === 'icebox') return;
      let text = db.redactSecrets(card.id, reply.reply);
      if (reply.action === 'create_card') {
        const description = typeof reply.taskDescription === 'string' ? db.redactSecrets(card.id, reply.taskDescription).trim() : '';
        if (!description) throw new Error('The proposed task needs a description');
        const draft = db.createCard({ projectId: card.projectId, description: `${description}\n\nFollow-up to #${card.id}`, parentId: card.id, instructions: '', instructionsHash: null });
        text += `\n\nCreated #${draft.id} in the **Icebox**. Review the task and generate instructions before using **Move to Backlog**.`;
      }
      db.addComment(card.id, 'coordinator', 'reply', text);
      // Only requested input can continue the existing blocked task. New work is always a draft.
      if (reply.action === 'resume' && current.stage === 'deliverables' && ['input', 'blocked'].includes(current.deliverableKind ?? '') && current.stageChangedAt === card.stageChangedAt) {
        this.resume(current, db.redactSecrets(card.id, reply.rework));
      }
    }).catch((err) => {
      if (controller.signal.aborted) return;
      const message = db.redactSecrets(card.id, err instanceof Error ? err.message : String(err));
      db.addComment(card.id, 'coordinator', 'reply', `I couldn't process that: ${message}`);
    }).finally(() => {
      if (this.replyJobs.get(card.id)?.controller === controller) {
        this.replyJobs.delete(card.id);
        emit({ type: 'chat', cardId: card.id, busy: false });
      }
    });
    this.replyJobs.set(card.id, { controller, promise });
    emit({ type: 'chat', cardId: card.id, busy: true });
  }

  /** Saves the human's message and secrets (values never go into the thread). */
  private storeInput(cardId: number, body: string, secrets: Record<string, string>, via: Via = null): void {
    const provided = Object.fromEntries(Object.entries(secrets).filter(([k, v]) => /^[A-Z_][A-Z0-9_]*$/i.test(k) && typeof v === 'string' && v));
    const names = Object.keys(provided);
    if (names.length) db.setSecrets(cardId, provided);
    const text = `${body.trim()}${names.length ? `\n\n_Provided secret(s): ${names.map((n) => `\`${n}\``).join(', ')}_` : ''}`.trim();
    if (text) db.addComment(cardId, 'user', 'input', db.redactSecrets(cardId, text), via);
  }

  private resume(card: Card, input: string): void {
    const blocked = db.listSubtasks(card.id).filter((s) => s.status === 'blocked');
    const note = input.trim() ? `\n\nInput from the human:\n${input.trim()}` : '';
    let target: Stage = 'in_progress';

    if (blocked.length) {
      for (const s of blocked) db.updateSubtask(s.id, { status: 'pending', instructions: `${s.instructions}${note}` });
    } else if (card.resumeStage === 'backlog') {
      // Failed before planning finished: plan again from scratch.
      target = 'backlog';
    } else if (card.deliverableKind === 'blocked') {
      for (const s of db.listSubtasks(card.id).filter((x) => x.status === 'failed')) {
        db.updateSubtask(s.id, { status: 'pending', attempts: 0, instructions: `${s.instructions}${note}` });
      }
      if (input.trim() && !db.listSubtasks(card.id).some((s) => s.status === 'pending')) {
        db.addSubtasks(card.id, db.currentRound(card.id) + 1, [{ kind: 'fix', title: 'Address human guidance', instructions: input.trim(), doneWhen: 'The guidance is applied and tests pass.' }]);
      } else if (!input.trim()) {
        target = card.resumeStage ?? 'in_progress';
      }
      db.updateCard(card.id, { loops: 0 });
    } else {
      db.addSubtasks(card.id, db.currentRound(card.id) + 1, [{
        kind: 'fix', title: 'Apply requested changes', instructions: input.trim() || 'Re-check the work against the task.', doneWhen: 'The requested changes are in place and tests pass.',
      }]);
    }
    db.updateCard(card.id, { deliverableKind: null, resumeStage: null });
    db.moveCard(card.id, target, 'top', `resumed${input.trim() ? ' with your input' : ''}`);
    db.setStatus(card.id, 'queued', `Resumed with your input → ${STAGE_LABELS[target]}`);
    this.tick();
  }

  // ------------------------------------------------------------ abort

  async abort(cardId: number): Promise<Card> {
    const card = this.mustBeIn(cardId, ['backlog', 'in_progress', 'verification', 'acceptance', 'deliverables']);
    this.aborting.add(card.id);
    try {
      return await this.abortCard(card);
    } finally {
      this.aborting.delete(card.id);
    }
  }

  private async abortCard(card: Card): Promise<Card> {
    const cfg = this.cfg();
    const job = this.jobs.get(card.id);
    job?.controller.abort();
    const replyJob = this.replyJobs.get(card.id);
    this.cancelReply(card.id);
    if (replyJob) await replyJob.promise;
    if (job) await Promise.race([job.promise, new Promise((r) => setTimeout(r, 15_000))]);

    const subs = db.listSubtasks(card.id);
    for (const s of subs) {
      if (['pending', 'running', 'blocked'].includes(s.status)) db.updateSubtask(s.id, { status: 'aborted', endedAt: Date.now() });
    }
    // Aborting a merge cancels only the merge: the completed work stays complete, on its branch.
    if (card.merging) {
      for (const dir of [...subs.map((s) => s.worktree), card.worktree]) {
        await removeWorktree(cfg.repoPath, dir).catch((err) => this.log(card, `Cleanup warning: ${err instanceof Error ? err.message : err}`, 'detail'));
      }
      db.updateCard(card.id, {
        worktree: null, merging: false, deliverableKind: null, resumeStage: null,
        mergeState: 'unmerged', mergeNote: `Merge cancelled; kept on ${card.branch}`, status: 'done', statusText: 'Merge cancelled',
      });
      this.announce(`#${card.id} merge cancelled`);
      return db.moveCard(card.id, 'complete', 'top', `merge cancelled; the work stays on ${card.branch}`)!;
    }
    let archived: string[] = [];
    try {
      archived = await archiveCard(cfg.repoPath, card.id, [...subs.map((s) => s.worktree), card.worktree]);
    } catch (err) {
      this.log(card, `Cleanup warning: ${err instanceof Error ? err.message : err}`, 'detail');
    }
    db.updateCard(card.id, {
      branch: null, worktree: null, loops: 0, coverage: null, acceptanceReady: false, deliverableKind: null, resumeStage: null,
      status: 'idle', statusText: `Aborted from ${STAGE_LABELS[card.stage]}`,
    });
    this.announce(`#${card.id} aborted`);
    return db.moveCard(card.id, 'icebox', 'top', `aborted${archived.length ? `; branches archived: ${archived.join(', ')}` : ''}`)!;
  }

  private mustBeIn(cardId: number, stages: Stage[]): Card {
    const card = db.getCard(cardId);
    if (!card || card.projectId !== this.projectId) throw new HttpError(404, `Card #${cardId} not found`);
    if (!stages.includes(card.stage)) throw new HttpError(409, `Card #${cardId} is in ${STAGE_LABELS[card.stage]}`);
    return card;
  }
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
