/**
 * The assistant: one conversation that spans every project. Its agent answers
 * status questions and proposes actions; this code validates and performs
 * them under the same rules as the board, and reports what actually happened.
 *
 * Notifications are code-driven so they're cheap and never missed: a card
 * completing (and a project with nothing left to do), a card waiting on the
 * user in Deliverables, and coordinator replies to messages it passed on.
 */
import path from 'node:path';
import * as db from './db.ts';
import { emit, subscribe } from './events.ts';
import { HttpError } from './coordinator.ts';
import { cardBrief } from './prompts.ts';
import { deliveryNotes } from './delivery.ts';
import { getProject, listProjects, settings } from './settings.ts';
import { assistantProfile, pickProfile, runProfile } from './profiles.ts';
import type { Factory } from './factory.ts';
import type { AgentContext, AssistantAction, Driver, ProjectDigest } from './agents/driver.ts';
import type { AgentProfile, AssistantMessage, Card, Comment, FactoryEvent, Stage } from './types.ts';
import { assertBudget } from './budget.ts';

/** Messages of history the agent sees. */
const HISTORY = 30;
const QUOTE_LIMIT = 600;
const RELAY_LIMIT = 1500;
const MAX_PREVIEWS = 8;
/** Completed cards older than this drop out of the agent's view of a board. */
const COMPLETE_WINDOW_MS = 14 * 86_400_000;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);
const quote = (text: string) => text.split('\n').map((line) => `> ${line}`).join('\n');
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The body of a `## Heading` section of generated instructions. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${heading}\\b`, 'i').test(l.trim()));
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l.trim()));
  const body = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
  return /^none\.?$/i.test(body) ? '' : body;
}

/** One sentence on where a completed card's work went. */
function mergeSummary(card: Card): string {
  if (card.mergeState === 'merged') return ` ${card.mergeNote}.`;
  if (card.mergeState === 'blocked') return ` Merge blocked: ${card.mergeNote.replace(/^Kept on \S+: /, '')}; the work is on \`${card.branch}\`.`;
  if (card.mergeState === 'unmerged') return ` Not merged yet; the work is on \`${card.branch}\`.`;
  return '';
}

interface Job {
  controller: AbortController;
  promise: Promise<void>;
}

export class Assistant {
  private factory: Factory;
  private driver: () => Driver;
  private job: Job | null = null;
  /** Background instruction generation, per card. */
  private generating = new Map<number, Job>();
  /** Last stage seen per card, so each stage change is announced once. */
  private stages = new Map<number, Stage>();
  /** Last merging flag seen per card; a merge is announced when it finishes. */
  private merges = new Map<number, boolean>();
  /** Merges that just ended, whose own notification replaces the completion one. */
  private mergeEnded = new Set<number>();
  /** Cards whose next coordinator reply is passed back to the user. */
  private relays = new Set<number>();
  private timers = new Set<NodeJS.Timeout>();
  private unsubscribe: () => void = () => {};
  private stopped = false;

  constructor(factory: Factory, driver: () => Driver) {
    this.factory = factory;
    this.driver = driver;
  }

  start(): void {
    for (const card of db.listCards()) {
      this.stages.set(card.id, card.stage);
      this.merges.set(card.id, card.merging);
    }
    this.unsubscribe = subscribe((event) => this.observe(event));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe();
    for (const timer of this.timers) clearTimeout(timer);
    const jobs = [...(this.job ? [this.job] : []), ...this.generating.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map((j) => j.promise));
  }

  get busy(): boolean {
    return !!this.job;
  }

  // ------------------------------------------------------------ conversation

  /** A new message replaces a reply still being thought about; actions already under way finish. */
  send(body: string): void {
    const text = body.trim();
    if (!text) throw new HttpError(400, 'Say something');
    if (this.stopped) throw new HttpError(409, 'The assistant is shutting down');
    this.job?.controller.abort();
    db.addAssistantMessage({ author: 'user', kind: 'message', body: text });
    const controller = new AbortController();
    const promise = this.respond(controller.signal).catch((err) => {
      if (!controller.signal.aborted) this.post('error', `I couldn't process that: ${errorText(err)}`);
    }).finally(() => {
      if (this.job?.controller !== controller) return;
      this.job = null;
      emit({ type: 'assistant_busy', busy: false });
    });
    this.job = { controller, promise };
    emit({ type: 'assistant_busy', busy: true });
  }

  private async respond(signal: AbortSignal): Promise<void> {
    const result = await this.driver().assist(
      { conversation: db.listAssistantMessages(HISTORY), projects: this.digest(), cardDetails: (id) => this.cardDetails(id) },
      { signal, log: () => {}, ...this.runAs(assistantProfile(), null, null) },
    );
    signal.throwIfAborted();
    this.post('message', result.reply, this.previews(result.cardIds));
    for (const action of result.actions) {
      // The reply is out; finish what it promised even if a newer message arrives.
      try {
        await this.perform(action);
      } catch (err) {
        const target = action.type === 'create_card' ? 'draft that card' : action.type === 'pull' || action.type === 'push' ? `${action.type} that project` : `act on #${action.cardId}`;
        this.post('error', `I couldn't ${target}: ${errorText(err)}`, this.previews([action.cardId]));
      }
    }
  }

  /** A run by `profile`, charged to the project and card it's for (none for the conversation itself). Refused over a budget. */
  private runAs(profile: AgentProfile, projectId: number | null, cardId: number | null): Pick<AgentContext, 'profile' | 'usage'> {
    assertBudget(projectId, profile);
    return { profile: runProfile(profile), usage: (u) => db.addUsage({ ...u, projectId, cardId, profileId: profile.id }) };
  }

  private post(kind: AssistantMessage['kind'], body: string, cardIds: number[] = [], details = ''): void {
    if (!this.stopped) db.addAssistantMessage({ author: 'assistant', kind, body, cardIds, details });
  }

  /** Only real, visible cards become previews. */
  private previews(ids: number[]): number[] {
    return [...new Set(ids)].filter((id) => {
      const card = db.getCard(id);
      return card && !card.hidden;
    }).slice(0, MAX_PREVIEWS);
  }

  // ------------------------------------------------------------ what the agent sees

  private digest(): ProjectDigest[] {
    const since = Date.now() - COMPLETE_WINDOW_MS;
    return listProjects().map((project) => ({
      id: project.id,
      name: project.name,
      repoName: path.basename(project.settings.repoPath),
      paused: project.settings.paused,
      cards: db.listCards(project.id)
        .filter((c) => !c.hidden && (c.stage !== 'complete' || (c.completedAt ?? 0) >= since))
        .map((c) => ({ id: c.id, title: c.title, stage: c.stage, statusText: c.statusText, waitingFor: c.deliverableKind, completedAt: c.completedAt, merge: c.mergeState, kind: c.kind })),
    }));
  }

  private cardDetails(cardId: number): string | null {
    const card = db.getCard(cardId);
    if (!card || card.hidden) return null;
    const subtasks = db.listSubtasks(card.id);
    const comments = db.listComments(card.id);
    const notes = deliveryNotes(card, subtasks, db.listLogs(card.id), comments, settings(card.projectId));
    return db.redactSecrets(card.id, cardBrief(card, getProject(card.projectId), subtasks, comments, notes));
  }

  // ------------------------------------------------------------ actions

  private async perform(action: AssistantAction): Promise<void> {
    const body = String(action.body ?? '').trim();
    if (action.type === 'create_card') return this.createCard(action.projectId, body);
    if (action.type === 'pull' || action.type === 'push') {
      const project = getProject(action.projectId);
      if (!project) throw new HttpError(404, `Project ${action.projectId} not found`);
      const card = this.factory.coordinator(project.id).requestSync(action.type, 'you asked, through the assistant');
      return this.post('action', `Queued #${card.id} to ${action.type === 'pull' ? `pull ${project.settings.remote} into` : `push to ${project.settings.remote} from`} **${project.settings.baseBranch}** in **${project.name}**.`, [card.id]);
    }
    const card = db.getCard(action.cardId);
    if (!card || card.hidden) throw new HttpError(404, `Card #${action.cardId} not found`);
    const coordinator = this.factory.forCard(card.id);
    const where = `in **${getProject(card.projectId)?.name}**`;

    switch (action.type) {
      case 'update_card': {
        if (card.stage !== 'icebox') throw new HttpError(409, 'Only Icebox cards can be edited');
        if (!body) throw new HttpError(400, 'The new description is empty');
        db.updateCard(card.id, { description: body });
        this.post('action', `Updated #${card.id} ${where}. Regenerating its agent instructions…`, [card.id]);
        return this.generate(card.id);
      }
      case 'move_to_backlog': {
        if (this.generating.has(card.id)) throw new HttpError(409, 'Its agent instructions are still being generated');
        coordinator.enqueue(card.id);
        return this.post('action', `Moved #${card.id} to the Backlog ${where}. The coordinator starts it when there is capacity.`, [card.id]);
      }
      case 'message_coordinator': {
        if (!body) throw new HttpError(400, 'The message is empty');
        coordinator.comment(card.id, body, {}, 'assistant');
        this.relays.add(card.id);
        return this.post('action', `Asked the coordinator on #${card.id}. I'll pass on the reply.`, [card.id]);
      }
      case 'approve': {
        this.mustWait(card, 'approval');
        await coordinator.approve(card.id, body || 'Approved via the assistant.', 'assistant');
        return this.post('action', `Approved #${card.id} ${where}.`, [card.id]);
      }
      case 'request_changes': {
        this.mustWait(card, 'approval');
        if (!body) throw new HttpError(400, 'Describe the changes you want');
        coordinator.requestChanges(card.id, body, 'assistant');
        return this.post('action', `Sent #${card.id} back to In Progress with your changes.`, [card.id]);
      }
      case 'merge': {
        const base = settings(card.projectId).baseBranch;
        const merge = coordinator.requestMerge(card.id, 'assistant');
        return this.post('action', `Queued #${merge.id} to merge #${card.id} into **${base}** ${where}. If ${base} has moved, it's verified again first; I'll tell you when it lands.`, [merge.id, card.id]);
      }
      case 'resume': {
        this.mustWait(card, 'input');
        coordinator.resumeFromDeliverables(card.id, body, {}, 'assistant');
        return this.post('action', `Resumed #${card.id} ${where}${body ? ' with your input' : ''}.`, [card.id]);
      }
      default:
        throw new HttpError(400, `Unknown action ${String((action as AssistantAction).type)}`);
    }
  }

  /** Mirrors the card thread: Approve/Request changes for approvals, Resume for input or help. */
  private mustWait(card: Card, kind: 'approval' | 'input'): void {
    if (card.stage !== 'deliverables') throw new HttpError(409, `#${card.id} isn't waiting in Deliverables`);
    if ((card.deliverableKind === 'approval') !== (kind === 'approval')) {
      throw new HttpError(409, card.deliverableKind === 'approval' ? `#${card.id} is waiting for approval, not input` : `#${card.id} is waiting for input, not approval`);
    }
  }

  private createCard(projectId: number, description: string): void {
    const project = getProject(projectId);
    if (!project) throw new HttpError(404, `Project ${projectId} not found`);
    if (!description) throw new HttpError(400, 'The task needs a description');
    const card = db.createCard({ projectId, description, instructions: '', instructionsHash: null });
    this.post('action', `Drafted #${card.id} in the **${project.name}** Icebox. Generating its agent instructions…`, [card.id]);
    this.generate(card.id);
  }

  /** Runs in the background so a new message can't cancel it; the result is shown for confirmation. */
  private generate(cardId: number): void {
    this.generating.get(cardId)?.controller.abort();
    const card = db.getCard(cardId)!;
    const description = card.description;
    const controller = new AbortController();
    const references = db.parseTags(description, card.id).map((id) => db.getCard(id)).filter((c): c is Card => !!c);
    const writer = pickProfile(card.projectId, 'coordinator');
    const promise = this.factory.driver(writer.provider)
      .generateInstructions({ description, references, repoPath: settings(card.projectId).repoPath }, () => {},
        { signal: controller.signal, ...this.runAs(writer, card.projectId, card.id) })
      .then((instructions) => {
        controller.signal.throwIfAborted();
        const current = db.getCard(cardId);
        if (!current || current.hidden || current.stage !== 'icebox') return;
        if (current.description !== description) {
          return this.post('action', `#${cardId} changed while I was generating its instructions. Open it to regenerate them.`, [cardId]);
        }
        db.updateCard(cardId, { instructions, instructionsHash: db.hashText(description) });
        this.post('action', this.confirmation(current, instructions), [cardId], instructions);
      })
      .catch((err) => {
        if (!controller.signal.aborted) this.post('error', `I couldn't generate instructions for #${cardId}: ${errorText(err)}`, [cardId]);
      })
      .finally(() => {
        if (this.generating.get(cardId)?.controller === controller) this.generating.delete(cardId);
      });
    this.generating.set(cardId, { controller, promise });
  }

  /** What the user needs to confirm the agents read the task right. */
  private confirmation(card: Card, instructions: string): string {
    const parts = [`Here is how the agents read #${card.id} **${card.title}**.`];
    for (const heading of ['Objective', 'Assumptions', 'Open questions']) {
      const body = section(instructions, heading);
      if (body) parts.push(`**${heading}**\n\n${clip(body, QUOTE_LIMIT)}`);
    }
    parts.push('Tell me to move it to the Backlog when it looks right, or what to change.');
    return parts.join('\n\n');
  }

  // ------------------------------------------------------------ notifications

  private observe(event: FactoryEvent): void {
    if (event.type === 'card') {
      const card = event.card;
      const before = this.stages.get(card.id);
      const wasMerging = this.merges.get(card.id) ?? false;
      this.stages.set(card.id, card.stage);
      this.merges.set(card.id, card.merging);
      if (card.hidden) return;
      if (wasMerging && !card.merging) {
        this.mergeEnded.add(card.id);
        return this.defer(() => this.announceMerge(card.id));
      }
      if (before === undefined || before === card.stage || this.mergeEnded.has(card.id)) return;
      // A merge pass reports once, when it lands; only a call for help interrupts it.
      if (card.merging && card.stage !== 'deliverables') return;
      // Deferred so the coordinator's question, posted right after the move, is included.
      if (card.stage === 'complete' || card.stage === 'deliverables') this.defer(() => this.announce(card.id, card.stage));
    } else if (event.type === 'comment' && event.comment.author === 'coordinator' && event.comment.kind === 'reply' && this.relays.has(event.comment.cardId)) {
      this.relays.delete(event.comment.cardId);
      const comment = event.comment;
      this.defer(() => this.relay(comment));
    }
  }

  private defer(fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.stopped) fn();
    }, 0);
    this.timers.add(timer);
  }

  private announce(cardId: number, stage: Stage): void {
    const card = db.getCard(cardId);
    if (!card || card.hidden || card.stage !== stage) return;
    const project = getProject(card.projectId)?.name ?? 'its project';
    if (stage === 'complete') {
      // A merge card's result is announced on the card it merged.
      if (card.kind === 'merge') return;
      if (card.kind !== 'task') return this.post('notification', `#${card.id} **${card.title}** in **${project}**: ${card.statusText}.`, [card.id]);
      return this.post('notification', `#${card.id} **${card.title}** is complete in **${project}**.${mergeSummary(card)}${this.allDone(card)}`, [card.id]);
    }
    const need = card.deliverableKind === 'approval' ? 'is ready for your approval' : card.deliverableKind === 'input' ? 'needs your input' : 'needs your help';
    const questions = this.openQuestions(card).map((c) => quote(clip(db.redactSecrets(card.id, c.body), QUOTE_LIMIT))).join('\n\n');
    this.post('notification', `#${card.id} **${card.title}** in **${project}** ${need}.${questions ? `\n\n${questions}` : ''}`, [card.id]);
  }

  private announceMerge(cardId: number): void {
    this.mergeEnded.delete(cardId);
    const card = db.getCard(cardId);
    if (!card || card.hidden || card.merging) return;
    const project = getProject(card.projectId)?.name ?? 'its project';
    if (/^Merge (?:#\d+ )?cancelled/.test(card.mergeNote)) {
      return this.post('notification', `The merge of #${card.id} **${card.title}** in **${project}** was cancelled; the work stays on \`${card.branch}\`.`, [card.id]);
    }
    this.post('notification', `#${card.id} **${card.title}** in **${project}**:${mergeSummary(card)}${this.allDone(card)}`, [card.id]);
  }

  /** A closing sentence when nothing is left in flight in the card's project. */
  private allDone(card: Card): string {
    const project = getProject(card.projectId)?.name ?? 'its project';
    const rest = db.listCards(card.projectId).filter((c) => !c.hidden && (c.merging || (c.stage !== 'icebox' && c.stage !== 'complete')));
    return rest.length ? '' : ` That was the last one: everything in **${project}** is done.`;
  }

  /** Coordinator questions since the user last spoke on the card. */
  private openQuestions(card: Card): Comment[] {
    const comments = db.listComments(card.id);
    const lastUser = comments.findLastIndex((c) => c.author === 'user');
    return comments.slice(lastUser + 1).filter((c) => c.author === 'coordinator' && c.kind === 'question').slice(-3);
  }

  private relay(comment: Comment): void {
    const card = db.getCard(comment.cardId);
    if (!card || card.hidden) return;
    this.post('relay', `The coordinator on #${card.id} replied:\n\n${quote(clip(db.redactSecrets(card.id, comment.body), RELAY_LIMIT))}`, [card.id]);
  }
}
