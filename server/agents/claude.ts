/**
 * Driver backed by the Claude Agent SDK. Each call is a separate agent
 * session with its own cwd (the relevant worktree) and tool permissions.
 */
import path from 'node:path';
import type { AssistantMessage, Card, Comment, Subtask } from '../types.ts';
import { createSdkMcpServer, query, tool, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  APPROVAL_SCHEMA, ASSISTANT_SCHEMA, ASSISTANT_SYSTEM, AUDIT_SCHEMA, AUDIT_SYSTEM, INSTRUCTIONS_SYSTEM, PLAN_SCHEMA, PLAN_SYSTEM, REPLY_SCHEMA,
  REPLY_SYSTEM, HANDOFF_SYSTEM, HANDOFF_SCHEMA, WORKER_SYSTEM, approvalPrompt, assistantPrompt, auditPrompt, instructionsPrompt, planPrompt, profileBrief, replyPrompt, handoffPrompt,
} from '../prompts.ts';
import type { RunProfile } from '../profiles.ts';
import { DATA_DIR } from '../settings.ts';
import type {
  AgentContext, ApprovalDecision, AssistantReply, InstructionEvent, AuditResult, CoordinatorReply, Driver, PlannedSubtask, ProjectDigest, RunUsage, WorkResult,
} from './driver.ts';

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

interface RunSpec {
  prompt: string;
  system: string;
  cwd: string;
  model: string;
  signal: AbortSignal;
  readOnly: boolean;
  /** Extra auto-approved tools for read-only agents, e.g. "Bash(git diff:*)". */
  extraTools?: string[];
  /** No built-in tools or filesystem settings at all; only `extraTools` (e.g. in-process MCP tools). */
  noFiles?: boolean;
  schema?: Record<string, unknown>;
  env?: Record<string, string>;
  mcpServers?: Options['mcpServers'];
  onMessage?: (m: SDKMessage) => void;
  /** The profile doing the run: its brief joins the system prompt, its skills load as a plugin, its model wins. */
  profile: RunProfile | null;
  onUsage: (usage: RunUsage) => void;
}

/** Describes a tool call as a one-line log entry ('' to skip it). */
function describeToolUse(name: string, input: any, cwd: string): string {
  const short = (s: unknown, n = 80) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
  const file = (p: unknown) => short(typeof p === 'string' && path.isAbsolute(p) ? path.relative(cwd, p) || '.' : p);
  switch (name) {
    case 'StructuredOutput': return '';
    case 'Read': return `Read ${file(input.file_path)}`;
    case 'Write': return `Wrote ${file(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Edited ${file(input.file_path)}`;
    case 'Bash': return `$ ${short(input.command)}`;
    case 'Glob': return `Glob ${short(input.pattern)}`;
    case 'Grep': return `Grep ${short(input.pattern)}`;
    default: return name.startsWith('mcp__factory__') ? '' : `${name} ${short(JSON.stringify(input), 60)}`;
  }
}

async function runAgent(spec: RunSpec): Promise<{ text: string; structured: unknown }> {
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  if (spec.signal.aborted) abort();
  spec.signal.addEventListener('abort', abort, { once: true });

  const options: Options = {
    cwd: spec.cwd,
    model: spec.profile?.model || spec.model,
    abortController,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.system + profileBrief(spec.profile) },
    ...(spec.profile?.pluginDir ? { plugins: [{ type: 'local', path: spec.profile.pluginDir, skipMcpDiscovery: true }] } : {}),
    settingSources: spec.noFiles ? [] : ['project'],
    env: { ...process.env, ...spec.env } as Record<string, string>,
    mcpServers: spec.mcpServers,
    ...(spec.noFiles
      ? { tools: [], permissionMode: 'dontAsk', allowedTools: spec.extraTools ?? [] }
      : spec.readOnly
        ? { permissionMode: 'dontAsk', allowedTools: [...READ_ONLY_TOOLS, ...(spec.extraTools ?? [])] }
        : { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }),
    ...(spec.schema ? { outputFormat: { type: 'json_schema', schema: spec.schema } } : {}),
  };

  try {
    let text = '';
    let structured: unknown;
    for await (const message of query({ prompt: spec.prompt, options })) {
      spec.onMessage?.(message);
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success' || message.is_error) {
        const detail = 'errors' in message ? (message as any).errors?.join('; ') : (message as any).result;
        throw new Error(`Agent ended with ${message.subtype}${detail ? `: ${detail}` : ''}`);
      }
      text = message.result;
      structured = message.structured_output;
      for (const [model, u] of Object.entries(message.modelUsage ?? {})) {
        spec.onUsage({
          model, inputTokens: u.inputTokens, outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadInputTokens, cacheWriteTokens: u.cacheCreationInputTokens, costUsd: u.costUSD,
        });
      }
    }
    if (spec.signal.aborted) throw new Error('aborted');
    return { text, structured };
  } finally {
    spec.signal.removeEventListener('abort', abort);
  }
}

/** Streams an agent's activity into the card log. */
function activityLogger(ctx: AgentContext, cwd: string) {
  return (m: SDKMessage) => {
    if (m.type !== 'assistant' || m.parent_tool_use_id) return;
    for (const block of m.message.content as any[]) {
      if (block.type === 'tool_use') {
        const line = describeToolUse(block.name, block.input, cwd);
        if (line) ctx.log('oneliner', line);
      } else if (block.type === 'text' && block.text.trim()) {
        ctx.log('detail', block.text.trim());
      }
    }
  };
}

export class ClaudeDriver implements Driver {
  readonly name = 'claude';
  private model: () => string;

  constructor(model: () => string) {
    this.model = model;
  }

  async generateInstructions(
    input: { description: string; references: any[]; repoPath: string },
    onEvent: (e: InstructionEvent) => void,
    ctx: Pick<AgentContext, 'signal' | 'profile' | 'usage'>,
  ): Promise<string> {
    const { text } = await runAgent({
      prompt: instructionsPrompt(input.description, input.references),
      system: INSTRUCTIONS_SYSTEM,
      cwd: input.repoPath,
      model: this.model(),
      signal: ctx.signal,
      profile: ctx.profile,
      onUsage: ctx.usage,
      readOnly: true,
      onMessage: (m) => {
        if (m.type !== 'assistant' || m.parent_tool_use_id) return;
        for (const block of m.message.content as any[]) {
          if (block.type === 'tool_use') {
            const line = describeToolUse(block.name, block.input, input.repoPath);
            if (line) onEvent({ type: 'status', text: line });
          }
        }
      },
    });
    const doc = text.trim();
    onEvent({ type: 'text', text: doc });
    return doc;
  }

  async plan(input: { card: any; references: any[]; repoPath: string }, ctx: AgentContext): Promise<PlannedSubtask[]> {
    const { structured } = await runAgent({
      prompt: planPrompt(input.card, input.references),
      system: PLAN_SYSTEM,
      cwd: input.repoPath,
      model: this.model(),
      signal: ctx.signal,
      profile: ctx.profile,
      onUsage: ctx.usage,
      readOnly: true,
      schema: PLAN_SCHEMA,
      onMessage: activityLogger(ctx, input.repoPath),
    });
    const plan = (structured as { subtasks: PlannedSubtask[] } | undefined)?.subtasks;
    if (!plan?.length) throw new Error('Planner returned no subtasks');
    return plan;
  }

  async work(
    input: { card: any; subtask: any; cwd: string; prompt: string; env: Record<string, string>; model: string },
    ctx: AgentContext,
  ): Promise<WorkResult> {
    let blocked: WorkResult['blocked'];
    const factoryTools = createSdkMcpServer({
      name: 'factory',
      version: '1.0.0',
      tools: [
        tool(
          'log_activity',
          'Record your progress for the humans watching the board. Call it often.',
          {
            one_liner: z.string().describe('What you just did or are doing, under 100 characters'),
            summary: z.string().optional().describe('A few sentences when you finish a meaningful step'),
            details: z.string().optional().describe('Longer notes: reasoning, findings, trade-offs'),
          },
          async (args) => {
            ctx.log('oneliner', args.one_liner);
            if (args.summary) ctx.log('summary', args.summary);
            if (args.details) ctx.log('detail', args.details);
            return { content: [{ type: 'text', text: 'logged' }] };
          },
        ),
        tool(
          'request_human_input',
          'Escalate to the human when you cannot proceed: missing credentials/API keys/tokens, a permission, or a decision only they can make. Stop working after calling this.',
          {
            question: z.string().describe('Exactly what you need and why'),
            secret_name: z.string().optional().describe('Environment variable name to provide it as, e.g. STRIPE_API_KEY'),
          },
          async (args) => {
            blocked = { question: args.question, secretName: args.secret_name };
            return { content: [{ type: 'text', text: 'Escalated to the human. Stop now and summarise where you got to.' }] };
          },
        ),
      ],
    });

    const { text } = await runAgent({
      prompt: input.prompt,
      system: WORKER_SYSTEM,
      cwd: input.cwd,
      model: input.model,
      signal: ctx.signal,
      profile: ctx.profile,
      onUsage: ctx.usage,
      readOnly: false,
      env: input.env,
      mcpServers: { factory: factoryTools },
      onMessage: activityLogger(ctx, input.cwd),
    });
    return { summary: text.trim(), blocked };
  }

  async audit(input: { card: any; cwd: string; lens: string; baseBranch: string; model: string }, ctx: AgentContext): Promise<AuditResult> {
    const { structured } = await runAgent({
      prompt: auditPrompt(input.card, input.lens, input.baseBranch),
      system: AUDIT_SYSTEM,
      cwd: input.cwd,
      model: input.model,
      signal: ctx.signal,
      profile: ctx.profile,
      onUsage: ctx.usage,
      // The auditor needs git to see the diff, but must not edit.
      readOnly: true,
      extraTools: ['Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)'],
      schema: AUDIT_SCHEMA,
      onMessage: activityLogger(ctx, input.cwd),
    });
    const result = structured as AuditResult | undefined;
    if (!result) throw new Error('Auditor returned no verdict');
    return result;
  }

  async decideApproval(input: { card: any; subtasks: any[] }, ctx: AgentContext): Promise<ApprovalDecision> {
    const { structured } = await runAgent({
      prompt: approvalPrompt(input.card, input.subtasks),
      system: 'You are the coordinator of a software factory deciding whether finished work needs a human.',
      cwd: input.card.worktree ?? process.cwd(),
      model: this.model(),
      signal: ctx.signal,
      profile: ctx.profile,
      onUsage: ctx.usage,
      readOnly: true,
      schema: APPROVAL_SCHEMA,
    });
    return structured as ApprovalDecision;
  }

  /** Read-only review instructions are prepared before the worktree is removed. */
  async handoff(input: { card: Card; subtasks: Subtask[]; cwd: string; verification: string }, ctx: AgentContext): Promise<string> {
    const { structured } = await runAgent({
      prompt: handoffPrompt(input.card, input.subtasks, input.verification),
      system: HANDOFF_SYSTEM, cwd: input.cwd, model: this.model(), signal: ctx.signal, profile: ctx.profile, onUsage: ctx.usage,
      readOnly: true, schema: HANDOFF_SCHEMA,
    });
    const notes = (structured as { notes?: string } | undefined)?.notes;
    if (!notes?.trim()) throw new Error('Coordinator returned no review instructions');
    return notes.trim();
  }

  /** Conversation can propose a draft, but it has no write or execution tools. */
  async reply(input: { card: Card; thread: Comment[]; subtasks: Subtask[]; repoPath: string; deliveryNotes: string }, ctx: AgentContext): Promise<CoordinatorReply> {
    const { structured } = await runAgent({
      prompt: replyPrompt(input.card, input.thread, input.subtasks, input.deliveryNotes),
      system: REPLY_SYSTEM,
      cwd: input.repoPath,
      model: this.model(),
      signal: ctx.signal,
      profile: ctx.profile,
      onUsage: ctx.usage,
      readOnly: true,
      schema: REPLY_SCHEMA,
    });
    const reply = structured as CoordinatorReply | undefined;
    if (!reply || !['none', 'resume', 'create_card'].includes(reply.action) || !reply.reply?.trim()) {
      throw new Error('Coordinator returned an invalid reply');
    }
    return reply;
  }

  /** The assistant reads boards through one read-only tool; it has no file, shell or write access. */
  async assist(
    input: { conversation: AssistantMessage[]; projects: ProjectDigest[]; cardDetails: (cardId: number) => string | null },
    ctx: AgentContext,
  ): Promise<AssistantReply> {
    const boards = createSdkMcpServer({
      name: 'factory',
      version: '1.0.0',
      tools: [
        tool(
          'card_details',
          'Read one card in full: description, agent instructions, subtasks, recent thread and review notes.',
          { card_id: z.number().int().describe('The card number, e.g. 12 for #12') },
          async (args) => ({ content: [{ type: 'text', text: input.cardDetails(args.card_id) ?? `Card #${args.card_id} not found.` }] }),
        ),
      ],
    });
    const { structured } = await runAgent({
      prompt: assistantPrompt(input.conversation, input.projects),
      system: ASSISTANT_SYSTEM,
      cwd: DATA_DIR,
      model: this.model(),
      signal: ctx.signal,
      profile: ctx.profile,
      onUsage: ctx.usage,
      readOnly: true,
      noFiles: true,
      extraTools: ['mcp__factory__card_details'],
      mcpServers: { factory: boards },
      schema: ASSISTANT_SCHEMA,
    });
    const reply = structured as AssistantReply | undefined;
    if (!reply?.reply?.trim() || !Array.isArray(reply.actions) || !Array.isArray(reply.cardIds)) {
      throw new Error('Assistant returned an invalid reply');
    }
    return reply;
  }
}
