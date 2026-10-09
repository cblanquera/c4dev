/**
 * The contract between the coordinator and whatever intelligence backs it.
 * The coordinator owns the state machine; a driver only answers questions
 * ("plan this", "build this", "audit this") and reports activity via `log`.
 */
import type { AssistantMessage, Card, CardKind, Comment, DeliverableKind, LogLevel, MergeState, Stage, Subtask, SubtaskKind } from '../types.ts';
import type { RunProfile } from '../profiles.ts';

/** Tokens and estimated cost of one run, per model. */
export interface RunUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface AgentContext {
  signal: AbortSignal;
  /** Record activity in one of the four log forms. */
  log: (level: LogLevel, text: string) => void;
  /** Who does this run: their brief, model and skills. */
  profile: RunProfile | null;
  /** Report what the run used; the caller records it against the project, card and profile. */
  usage: (usage: RunUsage) => void;
}

export interface PlannedSubtask {
  title: string;
  instructions: string;
  doneWhen: string;
  /** 0-based indexes of earlier subtasks in the same plan. */
  dependsOn: number[];
  kind?: SubtaskKind;
}

export interface WorkResult {
  summary: string;
  /** Set when the worker cannot continue without a human. */
  blocked?: { question: string; secretName?: string };
}

export interface Recommendation {
  title: string;
  detail: string;
  severity: 'must' | 'should' | 'nit';
  files: string[];
}

export interface AuditResult {
  approved: boolean;
  summary: string;
  recommendations: Recommendation[];
}

export interface ApprovalDecision {
  needsApproval: boolean;
  kind: 'approval' | 'input';
  reason: string;
  questions: string[];
}

export interface CoordinatorReply {
  reply: string;
  /** New development work is drafted in the Icebox; resume is only for requested input. */
  action: 'none' | 'resume' | 'create_card';
  taskDescription: string;
  /** Input for an existing blocked task when action is resume. */
  rework: string;
}

/** Something the assistant asks code to do. Code validates every action before acting. */
export interface AssistantAction {
  type: 'create_card' | 'update_card' | 'move_to_backlog' | 'message_coordinator' | 'approve' | 'request_changes' | 'resume' | 'merge' | 'pull' | 'push';
  /** Target project for create_card, pull and push; 0 otherwise. */
  projectId: number;
  /** Target card for every other action; 0 for create_card. */
  cardId: number;
  /** Task description, message, note or requested changes. */
  body: string;
}

export interface AssistantReply {
  reply: string;
  /** Cards to show as clickable previews under the reply. */
  cardIds: number[];
  actions: AssistantAction[];
}

/** What the assistant sees of one project. */
export interface ProjectDigest {
  id: number;
  name: string;
  /** The repository folder name, which users often call the project by. */
  repoName: string;
  paused: boolean;
  cards: {
    id: number; title: string; stage: Stage; statusText: string; waitingFor: DeliverableKind | null; completedAt: number | null;
    /** Integration cards (merge, pull, push) are queued by the factory, not written by the user. */
    kind?: CardKind;
    /** Completed cards only: whether the branch reached the base branch. */
    merge?: MergeState | null;
  }[];
}

/** Progress while generating instructions: tool activity, then the document. */
export interface InstructionEvent {
  type: 'status' | 'text';
  text: string;
}

export interface Driver {
  readonly name: string;

  generateInstructions(
    input: { description: string; references: Card[]; repoPath: string },
    onEvent: (e: InstructionEvent) => void,
    ctx: Pick<AgentContext, 'signal' | 'profile' | 'usage'>,
  ): Promise<string>;

  plan(input: { card: Card; references: Card[]; repoPath: string }, ctx: AgentContext): Promise<PlannedSubtask[]>;

  work(
    input: { card: Card; subtask: Subtask; cwd: string; prompt: string; env: Record<string, string>; model: string },
    ctx: AgentContext,
  ): Promise<WorkResult>;

  audit(input: { card: Card; cwd: string; lens: string; baseBranch: string; model: string }, ctx: AgentContext): Promise<AuditResult>;

  decideApproval(input: { card: Card; subtasks: Subtask[] }, ctx: AgentContext): Promise<ApprovalDecision>;

  handoff(input: { card: Card; subtasks: Subtask[]; cwd: string; verification: string }, ctx: AgentContext): Promise<string>;

  reply(input: { card: Card; thread: Comment[]; subtasks: Subtask[]; repoPath: string; deliveryNotes: string }, ctx: AgentContext): Promise<CoordinatorReply>;

  /** The cross-project assistant. Read-only: it proposes actions; code performs them. */
  assist(
    input: { conversation: AssistantMessage[]; projects: ProjectDigest[]; cardDetails: (cardId: number) => string | null },
    ctx: AgentContext,
  ): Promise<AssistantReply>;
}
