/** Example display profiles; persisted actor IDs still identify each real agent run. */
import type { Subtask } from '../../server/types.ts';

const WORKER_NAMES = ['Alex', 'Jamie', 'Sam', 'Riley', 'Casey', 'Jordan', 'Taylor', 'Morgan'];
export type AgentJob = 'Coordinator' | 'Designer' | 'Developer' | 'Auditor' | 'Senior Developer';
export const AGENT_JOBS: { title: AgentJob; context: string }[] = [
  { title: 'Coordinator', context: 'The current card, its plan, dependencies, and repository. Assigns tasks, checks progress, and prepares the review handoff.' },
  { title: 'Designer', context: 'An assigned design task and its isolated worktree. Reports layout, interaction, and visual design decisions.' },
  { title: 'Developer', context: 'An assigned implementation or fix and its isolated worktree. Reports code changes, trade-offs, and blockers.' },
  { title: 'Auditor', context: 'An assigned test or acceptance task and its isolated worktree. Reports test scenarios, scripts, and findings; recorded results show what actually ran.' },
  { title: 'Senior Developer', context: 'The combined card worktree and the current review lens. Reviews code and recommendations with read-only access.' },
];

export function agentProfile(actor: string, subtask?: Subtask) {
  let title: AgentJob = 'Developer';
  let name = actor;
  if (actor === 'coordinator') {
    title = 'Coordinator';
    name = 'Grace Hopper';
  } else if (actor === 'senior') {
    title = 'Senior Developer';
    name = 'Linus Torvalds';
  } else {
    const worker = actor.match(/^worker-(\d+)$/);
    if (worker) {
      const id = Number(worker[1]);
      name = WORKER_NAMES[(id - 1) % WORKER_NAMES.length] ?? 'Alex';
      if (id > WORKER_NAMES.length) name += ` ${String.fromCharCode(65 + (Math.floor((id - 1) / WORKER_NAMES.length) % 26))}.`;
    }
    if (subtask?.kind === 'acceptance' || /^(?:tests?\b|write (?:the )?(?:tests?\b|acceptance\b)|qa\b)/i.test(subtask?.title.trim() ?? '')) title = 'Auditor';
    else if (/^(?:design\b|wireframe\b|mockup\b|prototype\b)/i.test(subtask?.title.trim() ?? '')) title = 'Designer';
  }
  const context = AGENT_JOBS.find((job) => job.title === title)!.context;
  return { name, title, context: subtask ? `${context} Assigned task: ${subtask.title}.` : context };
}

export function agentLabel(actor: string, subtask?: Subtask): string {
  const profile = agentProfile(actor, subtask);
  return `${profile.name} · ${profile.title}`;
}
