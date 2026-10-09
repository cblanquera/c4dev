/**
 * The contract between the coordinator and whatever intelligence backs it.
 * The coordinator owns the state machine; a driver only answers questions
 * ("plan this", "build this", "audit this") and reports activity via `log`.
 */
import type { Card, Comment, LogLevel, Subtask, SubtaskKind } from '../types.ts';

export interface AgentContext {
  signal: AbortSignal;
  /** Record activity in one of the four log forms. */
  log: (level: LogLevel, text: string) => void;
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
    signal: AbortSignal,
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
}
