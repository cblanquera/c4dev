/**
 * Shared domain types for the software factory.
 * The web client imports these too, so keep this file free of Node imports.
 */

export const STAGES = [
  'icebox',
  'backlog',
  'in_progress',
  'verification',
  'acceptance',
  'deliverables',
  'complete',
] as const;

export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  icebox: 'Icebox',
  backlog: 'Backlog',
  in_progress: 'In Progress',
  verification: 'Verification',
  acceptance: 'Acceptance',
  deliverables: 'Deliverables',
  complete: 'Complete',
};

/** Stages where the coordinator owns the card and agents may be running. */
export const ACTIVE_STAGES: readonly Stage[] = ['in_progress', 'verification', 'acceptance'];

/** Why a card is sitting in Deliverables. */
export type DeliverableKind = 'approval' | 'input' | 'blocked';

export interface Card {
  id: number;
  title: string;
  description: string;
  instructions: string;
  /** Hash of the description the instructions were generated from. */
  instructionsHash: string | null;
  /** True when the instructions were generated from the current description. */
  instructionsCurrent: boolean;
  stage: Stage;
  position: number;
  /** Short machine status, e.g. "planning", "running", "testing". */
  status: string;
  /** Human-readable status line shown on the card. */
  statusText: string;
  tags: number[];
  parentId: number | null;
  branch: string | null;
  worktree: string | null;
  /** How many times the card has bounced back to In Progress. */
  loops: number;
  coverage: number | null;
  acceptanceReady: boolean;
  deliverableKind: DeliverableKind | null;
  /** Stage to return to when a blocked card gets its input. */
  resumeStage: Stage | null;
  /** Names of secrets attached to the card (values are never sent to the client). */
  secretNames: string[];
  hidden: boolean;
  createdAt: number;
  updatedAt: number;
  stageChangedAt: number;
  completedAt: number | null;
}

export type SubtaskKind = 'build' | 'fix' | 'acceptance' | 'merge';
export type SubtaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'aborted' | 'blocked';

export interface Subtask {
  id: number;
  cardId: number;
  seq: number;
  round: number;
  kind: SubtaskKind;
  title: string;
  instructions: string;
  /** Measurable definition of done for the worker. */
  doneWhen: string;
  dependsOn: number[];
  status: SubtaskStatus;
  worker: string | null;
  branch: string | null;
  worktree: string | null;
  summary: string;
  diff: string;
  files: FileChange[];
  attempts: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
}

/** The four log forms: one-liner, summary, details, diff. */
export type LogLevel = 'oneliner' | 'summary' | 'detail' | 'diff';

export interface LogEntry {
  id: number;
  cardId: number;
  subtaskId: number | null;
  actor: string;
  level: LogLevel;
  text: string;
  ts: number;
}

export type CommentAuthor = 'user' | 'coordinator';
export type CommentKind = 'note' | 'question' | 'input' | 'reply' | 'approval' | 'changes' | 'handoff';

export interface Comment {
  id: number;
  cardId: number;
  author: CommentAuthor;
  kind: CommentKind;
  body: string;
  ts: number;
}

export type DriverName = 'simulated' | 'claude';

export interface Settings {
  /** Absolute path to the git repository agents work on. */
  repoPath: string;
  baseBranch: string;
  driver: DriverName;
  model: string;
  /** Model used by the senior auditor. */
  seniorModel: string;
  /** Max cards the coordinator works on at once. */
  maxActiveCards: number;
  /** Max worker agents running at once, across all cards. */
  maxWorkers: number;
  /** Runs in every new worktree, e.g. "npm ci". */
  setupCommand: string;
  testCommand: string;
  coverageCommand: string;
  coverageMin: number;
  coverageTarget: number;
  /** {card} expands to the card id. */
  acceptanceCommand: string;
  /** Focus areas for the senior audit; one pass per lens. */
  auditLenses: string[];
  /** Bounces back to In Progress before the card is escalated to Deliverables. */
  maxLoops: number;
  /** What to do with the card branch when it reaches Complete. */
  onComplete: 'keep' | 'merge';
  completeRetentionDays: number;
  paused: boolean;
}

export type FactoryEvent =
  | { type: 'card'; card: Card }
  | { type: 'card_removed'; id: number }
  | { type: 'subtask'; subtask: Subtask }
  | { type: 'log'; log: LogEntry }
  | { type: 'comment'; comment: Comment }
  | { type: 'chat'; cardId: number; busy: boolean }
  | { type: 'settings'; settings: Settings }
  | { type: 'coordinator'; text: string; ts: number };

export interface CardDetail {
  card: Card;
  subtasks: Subtask[];
  logs: LogEntry[];
  comments: Comment[];
  deliveryNotes: string;
  chatBusy: boolean;
}

/** Processes the factory can identify and stop without accepting arbitrary PIDs. */
export interface ProjectProcess {
  id: string;
  summary: string;
  pid: number | null;
  url: string;
  startedAt: string;
  stopsAt: string | null;
  currentServer: boolean;
}
