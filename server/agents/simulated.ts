/**
 * A deterministic stand-in for real agents. It plans from the description's
 * bullet points, writes real files into the worktree (so commits, diffs and
 * merges are genuine), raises one audit finding on the first pass, and
 * escalates to a human when a task mentions credentials. Use it to try the
 * factory without spending tokens, and in tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { recordedDelivery } from '../delivery.ts';
import { settings } from '../settings.ts';
import type {
  AgentContext, ApprovalDecision, AuditResult, CoordinatorReply, Driver, InstructionEvent, PlannedSubtask, WorkResult,
} from './driver.ts';
import type { Card, Comment, Subtask } from '../types.ts';

/** Scales every simulated delay; tests set FACTORY_SIM_SPEED=0. */
const SPEED = Number(process.env.FACTORY_SIM_SPEED ?? 1);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms * SPEED);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';

const SECRET_RE = /(api[ _-]?key|\btoken|credential|password|secret|\blogin\b)/i;
const APPROVAL_RE = /\b(approv\w*|review|sign[- ]?off|decid\w*|decision|confirm|payment|migration|delete)\b/i;

function bullets(markdown: string): string[] {
  return markdown
    .split('\n')
    .map((l) => l.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ x]\]\s*)?(.+)$/)?.[1]?.trim())
    .filter((l): l is string => !!l && !l.startsWith('!['));
}

function titleOf(markdown: string): string {
  const line = markdown.split('\n').map((l) => l.trim()).find(Boolean) ?? 'the task';
  return line.replace(/^#+\s*/, '');
}

function secretNameFor(description: string): string {
  const m = description.match(/\b([A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD))\b/);
  return m?.[1] ?? 'SERVICE_API_KEY';
}

export class SimulatedDriver implements Driver {
  readonly name = 'simulated';

  async generateInstructions(
    input: { description: string; references: Card[] },
    onEvent: (e: InstructionEvent) => void,
    signal: AbortSignal,
  ): Promise<string> {
    const title = titleOf(input.description);
    const items = bullets(input.description);
    const words = input.description.split(/\s+/).filter(Boolean).length;
    onEvent({ type: 'status', text: 'Glob **/*' });
    await sleep(300, signal);
    onEvent({ type: 'status', text: 'Read README.md' });
    await sleep(300, signal);

    const criteria = items.length ? items : [`${title} works as described`, 'Existing tests still pass'];
    const doc = [
      `## Objective\n${title}.`,
      `## Context\n- Repository explored read-only (simulated driver).${input.references.map((r) => `\n- Builds on #${r.id}: ${r.title}`).join('')}`,
      `## Scope\n**In scope**\n${criteria.map((c) => `- ${c}`).join('\n')}\n\n**Out of scope**\n- Anything not listed above`,
      `## Implementation notes\n${criteria.map((c, i) => `${i + 1}. Implement: ${c}`).join('\n')}`,
      `## Acceptance criteria\n${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
      `## Test plan\n- Unit tests for each item above\n- Acceptance journey: a user completes "${title}" on desktop and mobile`,
      `## Needs from a human\n${SECRET_RE.test(input.description) ? `- A credential provided as \`${secretNameFor(input.description)}\`` : APPROVAL_RE.test(input.description) ? '- Sign-off on the result' : 'None'}`,
      `## Assumptions\n- Follow the existing code style and test runner.`,
      `## Open questions\n${words < 12 ? '- The description is brief. What does "done" look like? Add bullet points describing the expected behaviour.' : 'None'}`,
    ].join('\n\n');

    // Stream in small chunks so the UI behaves like the real driver.
    for (let i = 0; i < doc.length; i += 60) {
      onEvent({ type: 'text', text: doc.slice(i, i + 60) });
      await sleep(15, signal);
    }
    return doc;
  }

  async plan(input: { card: Card }, ctx: AgentContext): Promise<PlannedSubtask[]> {
    ctx.log('oneliner', 'Reading the agent instructions');
    await sleep(500, ctx.signal);
    const items = bullets(input.card.description).slice(0, 5);
    if (items.length >= 2) {
      return items.map((item) => ({ title: item, instructions: `Implement: ${item}`, doneWhen: `"${item}" is implemented with tests`, dependsOn: [] }));
    }
    const title = input.card.title;
    return [
      { title: `Implement ${title}`, instructions: `Implement the core of: ${title}`, doneWhen: 'Core behaviour implemented', dependsOn: [] },
      { title: `Tests for ${title}`, instructions: `Write unit tests for: ${title}`, doneWhen: 'Tests cover the new behaviour', dependsOn: [0] },
    ];
  }

  async work(input: { card: Card; subtask: Subtask; cwd: string; env: Record<string, string> }, ctx: AgentContext): Promise<WorkResult> {
    const { card, subtask, cwd } = input;
    ctx.log('oneliner', `Starting: ${subtask.title}`);
    await sleep(600, ctx.signal);

    const secretName = secretNameFor(card.description);
    if (subtask.kind === 'build' && SECRET_RE.test(card.description) && !input.env[secretName]) {
      ctx.log('oneliner', `Blocked: needs ${secretName}`);
      return {
        summary: `Stopped before calling the external service: no ${secretName} available.`,
        blocked: { question: `I need a credential to continue. Please provide ${secretName} (it will be injected as an environment variable).`, secretName },
      };
    }

    ctx.log('oneliner', 'Glob src/**/*');
    await sleep(400, ctx.signal);

    let file: string;
    if (subtask.kind === 'acceptance') {
      const journey = slug(card.title);
      file = path.join('acceptance', `card-${card.id}`, journey, 'happy-path.spec.md');
      const content = `# Journey: ${card.title}\n\n## Use case: happy path\n- desktop 1280x800\n- mobile 390x844\n- visual: screenshot after each step\n`;
      fs.mkdirSync(path.join(cwd, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(cwd, file), content);
    } else {
      file = path.join('factory-sim', `card-${card.id}`, `${String(subtask.seq).padStart(2, '0')}-${slug(subtask.title)}.md`);
      fs.mkdirSync(path.join(cwd, path.dirname(file)), { recursive: true });
      const prev = fs.existsSync(path.join(cwd, file)) ? fs.readFileSync(path.join(cwd, file), 'utf8') : '';
      fs.writeFileSync(path.join(cwd, file), `${prev}# ${subtask.title}\n\n${subtask.instructions}\n\n_attempt ${subtask.attempts}, ${subtask.kind}_\n`);
    }
    ctx.log('oneliner', `Wrote ${file}`);
    await sleep(500, ctx.signal);
    ctx.log('oneliner', '$ npm test');
    await sleep(500, ctx.signal);
    ctx.log('detail', `Implemented "${subtask.title}" in ${file}. The simulated driver writes a markdown note instead of code so diffs and merges are real but harmless.`);
    ctx.log('summary', `Completed "${subtask.title}".`);
    return { summary: `Completed "${subtask.title}" (${file}).` };
  }

  async audit(input: { card: Card; lens: string }, ctx: AgentContext): Promise<AuditResult> {
    ctx.log('oneliner', `$ git diff main...HEAD`);
    await sleep(500, ctx.signal);
    // Raise one finding on the very first pass so the In Progress ⇄ Verification loop is visible.
    if (input.card.loops === 0 && /^logic/i.test(input.lens)) {
      return {
        approved: false,
        summary: 'One branch can be flattened.',
        recommendations: [{
          title: 'Flatten nested conditionals',
          detail: 'Use early returns to reduce nesting and cyclomatic complexity in the new code.',
          severity: 'should',
          files: [`factory-sim/card-${input.card.id}`],
        }],
      };
    }
    return { approved: true, summary: 'Looks good for this lens.', recommendations: [] };
  }

  async decideApproval(input: { card: Card }, ctx: AgentContext): Promise<ApprovalDecision> {
    await sleep(300, ctx.signal);
    const d = input.card.description;
    if (SECRET_RE.test(d)) {
      return { needsApproval: true, kind: 'approval', reason: 'Work uses a credential you provided; please confirm it behaves correctly with the real service.', questions: ['Does it work against the live service?'] };
    }
    if (APPROVAL_RE.test(d)) {
      return { needsApproval: true, kind: 'approval', reason: 'The task asks for human review.', questions: ['Does the result match what you had in mind?'] };
    }
    return { needsApproval: false, kind: 'approval', reason: 'Routine change; tests and acceptance passed.', questions: [] };
  }

  async handoff(input: { card: Card; subtasks: Subtask[]; cwd: string; verification: string }, ctx: AgentContext): Promise<string> {
    await sleep(200, ctx.signal);
    ctx.signal.throwIfAborted();
    const checks = [...new Set(input.verification.split('\n').filter(Boolean))].map((line) => `- ${line}`).join('\n');
    return recordedDelivery(input.card, input.subtasks, [], settings()).replace('No passing verification results recorded yet.', checks || 'No passing verification results recorded yet.');
  }

  async reply(input: { card: Card; thread: Comment[]; deliveryNotes: string }, ctx: AgentContext): Promise<CoordinatorReply> {
    await sleep(400, ctx.signal);
    ctx.signal.throwIfAborted();
    const last = [...input.thread].reverse().find((c) => c.author === 'user')?.body.trim() ?? '';
    const answer = (reply: string): CoordinatorReply => ({ reply, action: 'none', rework: '', taskDescription: '' });
    if (last.split(/\s+/).length < 3) {
      return answer('Could you say a bit more? What outcome do you want, and should I draft a task for it?');
    }
    if (/^(?:please\s+)?(?:(?:can|could|would|will) you\s+)?(?:add|build|implement|fix|change|create|remove|update|develop)\b/i.test(last)) {
      if (/^(?:please\s+)?(?:fix|change|update) (?:it|this|that)[.!?]?$/i.test(last) || /(?:make it better|improve (?:it|this))$/i.test(last)) {
        return answer('What should change, and how will we know it is done? Confirm the task you want me to draft.');
      }
      return { reply: 'I will draft this as a follow-up for you to review.', action: 'create_card', rework: '', taskDescription: last };
    }
    if (/\b(improve|better|maybe|perhaps|what if|could we|should we)\b/i.test(last)) {
      return answer('What specific change do you want? Should I create an Icebox card, or are we just discussing options?');
    }
    if (input.card.stage === 'deliverables' && ['input', 'blocked'].includes(input.card.deliverableKind ?? '') && /Provided secret\(s\):|^(?:please\s+)?(?:resume|continue|here is|use the)\b/i.test(last)) {
      return { reply: 'Understood. Continuing the existing task with your input.', action: 'resume', rework: last, taskDescription: '' };
    }
    if (/\b(approve|approved|lgtm|looks good|ship it)\b/i.test(last)) {
      return answer('Use Approve to accept the existing result. Chat can answer questions or draft a new Icebox card.');
    }
    if (/\b(review|test|login|url|view|changed|deliverable)\b/i.test(last)) {
      return answer(input.deliveryNotes || 'Review details will appear here after verification and acceptance. There is no recorded preview URL or test account yet.');
    }
    return answer(`Card #${input.card.id} is in ${input.card.stage.replaceAll('_', ' ')}. I can explain the recorded work or draft a follow-up in the Icebox. What would you like to know?`);
  }
}
