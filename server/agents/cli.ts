/**
 * Drivers for agent CLIs: Codex, OpenCode and Pi. Each role is one
 * non-interactive CLI process in the right folder, with the role's access
 * enforced by the CLI itself:
 *
 *   read-only  Codex `-s read-only` sandbox · OpenCode `plan` agent (no edits;
 *              approvals are refused without a person) · Pi `read,grep,find,ls`
 *   write      Codex `workspace-write` sandbox (network on) · OpenCode `build`
 *              agent with `--auto` · Pi with bash, edit and write added
 *
 * Their JSON event streams become activity logs and usage. Structured answers
 * use Codex's `--output-schema`; OpenCode and Pi are asked for the JSON and
 * it's parsed from their last message. Formats were checked against each
 * CLI's real output (see test/fixtures/providers).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, run, shellQuote } from '../shell.ts';
import {
  APPROVAL_SCHEMA, ASSISTANT_SCHEMA, ASSISTANT_SYSTEM, AUDIT_SCHEMA, AUDIT_SYSTEM, HANDOFF_SCHEMA, HANDOFF_SYSTEM, INSTRUCTIONS_SYSTEM,
  PLAN_SCHEMA, PLAN_SYSTEM, REPLY_SCHEMA, REPLY_SYSTEM, WORKER_CLI_SYSTEM, WORK_SCHEMA, approvalPrompt, assistantPrompt, auditPrompt,
  handoffPrompt, instructionsPrompt, planPrompt, profileBrief, replyPrompt,
} from '../prompts.ts';
import type { AssistantMessage, Card, Comment, Subtask } from '../types.ts';
import type {
  AgentContext, ApprovalDecision, AssistantReply, AuditResult, CoordinatorReply, Driver, InstructionEvent, PlannedSubtask,
  ProjectDigest, RunUsage, WorkResult,
} from './driver.ts';

export type CliProvider = 'codex' | 'opencode' | 'pi';
export type Access = 'none' | 'read' | 'write';

export interface CliRun {
  provider: CliProvider;
  cwd: string;
  prompt: string;
  /** Empty uses the CLI's own default. */
  model: string;
  access: Access;
  /** Codex only: a JSON Schema file its final message must follow. */
  schemaFile?: string;
}

const PI_READ_TOOLS = 'read,grep,find,ls';
const PI_WRITE_TOOLS = `${PI_READ_TOOLS},bash,edit,write`;
const MAX_DIFF = 80_000;

/** The command line for one run. Nothing but `write` runs can change files. */
export function cliCommand(spec: CliRun): string[] {
  const write = spec.access === 'write';
  const model = (flag: string) => (spec.model ? [flag, spec.model] : []);
  switch (spec.provider) {
    case 'codex':
      return ['codex', 'exec', '--json', '--skip-git-repo-check', '-C', spec.cwd, '-s', write ? 'workspace-write' : 'read-only',
        ...(write ? ['-c', 'sandbox_workspace_write.network_access=true'] : []), ...model('-m'),
        ...(spec.schemaFile ? ['--output-schema', spec.schemaFile] : []), spec.prompt];
    case 'opencode':
      return ['opencode', 'run', '--format', 'json', '--dir', spec.cwd, '--agent', write ? 'build' : 'plan', ...(write ? ['--auto'] : []), ...model('-m'), spec.prompt];
    case 'pi':
      // Pi has no folder flag; it is started inside `cwd`.
      return ['pi', '-p', '--mode', 'json', '--no-session',
        ...(spec.access === 'none' ? ['--no-tools'] : ['--tools', write ? PI_WRITE_TOOLS : PI_READ_TOOLS]), ...model('--model'), spec.prompt];
  }
}

// ------------------------------------------------------------ events

/** What one event line means to the factory. */
export interface CliEvent {
  /** A tool call, as a one-line log ("Read src/app.ts", "$ npm test"). */
  tool?: string;
  /** A message from the agent; the last one is its answer. */
  text?: string;
  usage?: RunUsage;
  error?: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const short = (s: string, n = 100) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** "Read x", "$ cmd" lines for file and shell tools, with paths shown relative to the run's folder. */
function describeTool(name: string, args: Record<string, unknown>, cwd: string): string {
  const file = (p: unknown) => {
    const value = str(p);
    return short(value && path.isAbsolute(value) ? path.relative(cwd, value) || '.' : value);
  };
  switch (name) {
    case 'read': return `Read ${file(args.filePath ?? args.path)}`;
    case 'write': return `Wrote ${file(args.filePath ?? args.path)}`;
    case 'edit': case 'multiedit': case 'patch': return `Edited ${file(args.filePath ?? args.path)}`;
    case 'bash': return `$ ${short(str(args.command))}`;
    case 'glob': case 'find': return `Glob ${short(str(args.pattern) || file(args.path))}`;
    case 'grep': return `Grep ${short(str(args.pattern))}`;
    case 'ls': case 'list': return `List ${file(args.path) || '.'}`;
    default: return `${name} ${short(JSON.stringify(args), 60)}`;
  }
}

/** Codex wraps commands as `/bin/zsh -lc '…'`; show just the command. */
function unwrapShell(command: string): string {
  const m = command.match(/^\S*sh -lc (?:(['"])([\s\S]*)\1|(\S+))$/);
  if (!m) return command;
  return m[3] ?? m[2].replace(/\\(["\\])/g, '$1');
}

/** Turns one line of a CLI's JSON stream into a factory event (null for lines that don't matter). */
export function parseLine(provider: CliProvider, line: string, cwd: string, model: string): CliEvent | null {
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    return null; // Logs on stderr and other noise.
  }
  if (!e || typeof e !== 'object') return null;
  if (provider === 'codex') {
    const item = e.item ?? {};
    if (e.type === 'item.started' && item.type === 'command_execution') return { tool: `$ ${short(unwrapShell(str(item.command)))}` };
    if (e.type === 'item.completed' && item.type === 'file_change') {
      return { tool: (item.changes ?? []).map((c: any) => `Edited ${path.relative(cwd, str(c.path)) || str(c.path)}`).join(', ') || 'Edited files' };
    }
    if (e.type === 'item.completed' && item.type === 'agent_message') return { text: str(item.text) };
    if (e.type === 'turn.completed' && e.usage) {
      const cached = Number(e.usage.cached_input_tokens) || 0;
      return { usage: {
        model: model || 'codex', inputTokens: Math.max(0, (Number(e.usage.input_tokens) || 0) - cached), outputTokens: Number(e.usage.output_tokens) || 0,
        cacheReadTokens: cached, cacheWriteTokens: Number(e.usage.cache_write_input_tokens) || 0, costUsd: 0,
      } };
    }
    if (e.type === 'error' || e.type === 'turn.failed') return { error: str(e.message) || str(e.error?.message) || 'Codex failed' };
    return null;
  }
  if (provider === 'opencode') {
    const part = e.part ?? {};
    if (e.type === 'tool_use') return { tool: describeTool(str(part.tool), part.state?.input ?? {}, cwd) };
    if (e.type === 'text' && part.text) return { text: str(part.text) };
    if (e.type === 'step_finish' && part.tokens) {
      const t = part.tokens;
      return { usage: {
        model: model || 'opencode', inputTokens: Number(t.input) || 0, outputTokens: (Number(t.output) || 0) + (Number(t.reasoning) || 0),
        cacheReadTokens: Number(t.cache?.read) || 0, cacheWriteTokens: Number(t.cache?.write) || 0, costUsd: Number(part.cost) || 0,
      } };
    }
    if (e.type === 'error') return { error: str(e.error?.data?.message) || str(e.error?.name) || 'OpenCode failed' };
    return null;
  }
  // Pi: tool calls stream as they start; agent_end carries every message with its usage.
  if (e.type === 'tool_execution_start') return { tool: describeTool(str(e.toolName), e.args ?? {}, cwd) };
  if (e.type === 'agent_end' && Array.isArray(e.messages)) {
    const replies = e.messages.filter((m: any) => m.role === 'assistant');
    const last = replies.at(-1);
    if (last?.stopReason === 'error' || last?.errorMessage) return { error: str(last.errorMessage) || 'Pi failed' };
    const text = (last?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => str(c.text)).join('\n').trim();
    const usage = replies.reduce((sum: RunUsage, m: any) => ({
      ...sum,
      model: m.provider && m.model ? `${m.provider}/${m.model}` : sum.model,
      inputTokens: sum.inputTokens + (Number(m.usage?.input) || 0),
      outputTokens: sum.outputTokens + (Number(m.usage?.output) || 0),
      cacheReadTokens: sum.cacheReadTokens + (Number(m.usage?.cacheRead) || 0),
      cacheWriteTokens: sum.cacheWriteTokens + (Number(m.usage?.cacheWrite) || 0),
      costUsd: sum.costUsd + (Number(m.usage?.cost?.total) || 0),
    }), { model: model || 'pi', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
    return { text, usage };
  }
  return null;
}

/** The JSON object in a reply: plain, fenced, or the outermost braces. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed, trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch { /* try the next form */ }
  }
  throw new Error(`The agent replied without the expected JSON: ${short(trimmed, 200) || '(empty)'}`);
}

// ------------------------------------------------------------ the driver

/** Runs `fn` in `dir`, or in a fresh empty folder that is removed afterwards. */
async function inFolder<T>(dir: string | null, fn: (cwd: string) => Promise<T>): Promise<T> {
  if (dir) return fn(dir);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-empty-'));
  try {
    return await fn(empty);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
}

interface RoleRun {
  system: string;
  prompt: string;
  cwd: string;
  model: string;
  access: Access;
  schema?: Record<string, unknown>;
  ctx: Pick<AgentContext, 'signal' | 'profile' | 'usage'> & { log?: AgentContext['log'] };
  /** Tool lines for live progress (instruction writing streams these). */
  onTool?: (line: string) => void;
}

export class CliDriver implements Driver {
  readonly name: CliProvider;
  private model: () => string;

  constructor(provider: CliProvider, model: () => string) {
    this.name = provider;
    this.model = model;
  }

  /** One CLI run: returns its last message, logging tools and reporting usage as they come. */
  private async runRole(spec: RoleRun): Promise<string> {
    const { ctx } = spec;
    const model = ctx.profile?.model || spec.model;
    const schemaNote = spec.schema && this.name !== 'codex'
      ? `\n\nReply with only one JSON object matching this JSON Schema, and nothing else:\n${JSON.stringify(spec.schema)}`
      : '';
    const prompt = `<instructions>\n${spec.system}${profileBrief(ctx.profile)}\n</instructions>\n\n${spec.prompt}${schemaNote}`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-cli-'));
    let schemaFile: string | undefined;
    if (spec.schema && this.name === 'codex') fs.writeFileSync(schemaFile = path.join(tmp, 'schema.json'), JSON.stringify(spec.schema));
    const argv = cliCommand({ provider: this.name, cwd: spec.cwd, prompt, model, access: spec.access, schemaFile });
    let last = '';
    let error = '';
    try {
      const res = await run(argv.map(shellQuote).join(' '), {
        cwd: spec.cwd, signal: ctx.signal,
        onLine: (line) => {
          const event = parseLine(this.name, line, spec.cwd, model);
          if (!event) return;
          if (event.tool) {
            ctx.log?.('oneliner', event.tool);
            spec.onTool?.(event.tool);
          }
          if (event.text) {
            if (last) ctx.log?.('detail', last);
            last = event.text;
          }
          if (event.usage) ctx.usage(event.usage);
          if (event.error) error = event.error;
        },
      });
      ctx.signal.throwIfAborted();
      if (error || res.code !== 0) {
        throw new Error(`${this.name} failed${error ? `: ${error}` : ` (exit ${res.code})`}\n${res.output.trim().split('\n').slice(-5).join('\n')}`);
      }
      return last.trim();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  private async structured<T>(spec: RoleRun & { schema: Record<string, unknown> }): Promise<T> {
    return extractJson(await this.runRole(spec)) as T;
  }

  async generateInstructions(
    input: { description: string; references: Card[]; repoPath: string },
    onEvent: (e: InstructionEvent) => void,
    ctx: Pick<AgentContext, 'signal' | 'profile' | 'usage'>,
  ): Promise<string> {
    const doc = await this.runRole({
      system: INSTRUCTIONS_SYSTEM, prompt: instructionsPrompt(input.description, input.references), cwd: input.repoPath,
      model: this.model(), access: 'read', ctx, onTool: (line) => onEvent({ type: 'status', text: line }),
    });
    if (!doc) throw new Error(`${this.name} returned no instructions`);
    onEvent({ type: 'text', text: doc });
    return doc;
  }

  async plan(input: { card: Card; references: Card[]; repoPath: string }, ctx: AgentContext): Promise<PlannedSubtask[]> {
    const result = await this.structured<{ subtasks: PlannedSubtask[] }>({
      system: PLAN_SYSTEM, prompt: planPrompt(input.card, input.references), cwd: input.repoPath, model: this.model(), access: 'read', schema: PLAN_SCHEMA, ctx,
    });
    if (!result?.subtasks?.length) throw new Error('Planner returned no subtasks');
    return result.subtasks;
  }

  /** Workers can't call factory tools from a CLI, so needing a person is part of their final answer. */
  async work(input: { card: Card; subtask: Subtask; cwd: string; prompt: string; env: Record<string, string>; model: string }, ctx: AgentContext): Promise<WorkResult> {
    const result = await this.structured<{ summary: string; blocked: boolean; question: string; secretName: string }>({
      system: WORKER_CLI_SYSTEM, prompt: input.prompt, cwd: input.cwd, model: input.model, access: 'write', schema: WORK_SCHEMA, ctx,
    });
    return {
      summary: String(result.summary ?? '').trim(),
      blocked: result.blocked ? { question: result.question || 'The worker needs your input.', secretName: result.secretName || undefined } : undefined,
    };
  }

  /** The diff is handed over, since read-only CLIs can't all run git. */
  async audit(input: { card: Card; cwd: string; lens: string; baseBranch: string; model: string }, ctx: AgentContext): Promise<AuditResult> {
    const diff = await git(input.cwd, 'diff', '--no-color', `${input.baseBranch}...HEAD`).catch(() => '');
    const shown = diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… diff truncated; read the files for the rest` : diff;
    const result = await this.structured<AuditResult>({
      system: AUDIT_SYSTEM, prompt: `${auditPrompt(input.card, input.lens, input.baseBranch)}\n\n<diff>\n${shown || '(no changes)'}\n</diff>`,
      cwd: input.cwd, model: input.model, access: 'read', schema: AUDIT_SCHEMA, ctx,
    });
    if (typeof result?.approved !== 'boolean' || !Array.isArray(result.recommendations)) throw new Error('Architect returned no verdict');
    return result;
  }

  /** Without a worktree it runs in an empty folder, never the factory's data folder. */
  async decideApproval(input: { card: Card; subtasks: Subtask[] }, ctx: AgentContext): Promise<ApprovalDecision> {
    return inFolder(input.card.worktree, (cwd) => this.structured<ApprovalDecision>({
      system: 'You are the coordinator of a software factory deciding whether finished work needs a human.',
      prompt: approvalPrompt(input.card, input.subtasks), cwd, model: this.model(), access: 'read', schema: APPROVAL_SCHEMA, ctx,
    }));
  }

  async handoff(input: { card: Card; subtasks: Subtask[]; cwd: string; verification: string }, ctx: AgentContext): Promise<string> {
    const result = await this.structured<{ notes?: string }>({
      system: HANDOFF_SYSTEM, prompt: handoffPrompt(input.card, input.subtasks, input.verification), cwd: input.cwd,
      model: this.model(), access: 'read', schema: HANDOFF_SCHEMA, ctx,
    });
    if (!result?.notes?.trim()) throw new Error('Coordinator returned no review instructions');
    return result.notes.trim();
  }

  async reply(input: { card: Card; thread: Comment[]; subtasks: Subtask[]; repoPath: string; deliveryNotes: string }, ctx: AgentContext): Promise<CoordinatorReply> {
    const reply = await this.structured<CoordinatorReply>({
      system: REPLY_SYSTEM, prompt: replyPrompt(input.card, input.thread, input.subtasks, input.deliveryNotes), cwd: input.repoPath,
      model: this.model(), access: 'read', schema: REPLY_SCHEMA, ctx,
    });
    if (!reply || !['none', 'resume', 'create_card'].includes(reply.action) || !reply.reply?.trim()) throw new Error('Coordinator returned an invalid reply');
    return reply;
  }

  /**
   * The assistant runs with no tools in an empty folder, so it can't read the
   * factory's data. Cards the user mentions are looked up up front instead.
   */
  async assist(
    input: { conversation: AssistantMessage[]; projects: ProjectDigest[]; cardDetails: (cardId: number) => string | null },
    ctx: AgentContext,
  ): Promise<AssistantReply> {
    const last = [...input.conversation].reverse().find((m) => m.author === 'user')?.body ?? '';
    const ids = [...new Set([...last.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))].slice(0, 5);
    const details = ids.map((id) => input.cardDetails(id)).filter(Boolean).join('\n\n---\n\n');
    const reply = await inFolder(null, (cwd) => this.structured<AssistantReply>({
      system: `${ASSISTANT_SYSTEM}\nYou have no tools here. Cards the user mentioned are described below; for others, ask the user.`,
      prompt: `${assistantPrompt(input.conversation, input.projects)}${details ? `\n\n<card_details>\n${details}\n</card_details>` : ''}`,
      cwd, model: this.model(), access: 'none', schema: ASSISTANT_SCHEMA, ctx,
    }));
    if (!reply?.reply?.trim() || !Array.isArray(reply.actions) || !Array.isArray(reply.cardIds)) throw new Error('Assistant returned an invalid reply');
    return reply;
  }
}
