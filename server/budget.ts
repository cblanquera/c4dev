/**
 * Monthly budgets. Projects and agents can cap their spend (the providers'
 * cost estimates) and their tokens (input plus output, which also covers
 * providers that report no cost). Months start on the 1st, server time. A run
 * that would start over a budget doesn't start: the card waits in
 * Deliverables, and a project over its budget pauses its coordinator.
 */
import * as db from './db.ts';
import { HttpError } from './errors.ts';
import { getProject } from './settings.ts';
import type { AgentProfile, UsageTotals } from './types.ts';

export class BudgetError extends Error {
  readonly scope: 'project' | 'agent';
  constructor(scope: 'project' | 'agent', message: string) {
    super(message);
    this.name = 'BudgetError';
    this.scope = scope;
  }
}

/** A budget from a form: a non-negative amount (whole tokens, cents for dollars), or 0 when empty. */
export function cleanBudget(value: unknown, kind: 'usd' | 'tokens'): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1e12) throw new HttpError(400, 'Budgets are amounts of zero or more (zero means no limit)');
  return kind === 'tokens' ? Math.round(n) : Math.round(n * 100) / 100;
}

/** The start of this calendar month. */
export function monthStart(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

const tokens = (u: UsageTotals) => u.inputTokens + u.outputTokens;
const usd = (n: number) => `$${n.toFixed(2)}`;

/** What's over, e.g. "$5.10 of its $5.00 monthly budget", or null. */
function over(u: UsageTotals, budgetUsd: number, budgetTokens: number): string | null {
  if (budgetUsd > 0 && u.costUsd >= budgetUsd) return `${usd(u.costUsd)} of its ${usd(budgetUsd)} monthly budget`;
  if (budgetTokens > 0 && tokens(u) >= budgetTokens) return `${tokens(u).toLocaleString('en-US')} of its ${budgetTokens.toLocaleString('en-US')} monthly tokens`;
  return null;
}

/** Why the project can't start more runs this month, or null. */
export function projectOverBudget(projectId: number): string | null {
  const project = getProject(projectId);
  if (!project) return null;
  const { budgetUsd, budgetTokens } = project.settings;
  if (!budgetUsd && !budgetTokens) return null;
  const reached = over(db.usageOf('project_id', projectId, monthStart()), budgetUsd, budgetTokens);
  return reached && `${project.name} has used ${reached}`;
}

/** Why the agent can't start more runs this month, or null. */
export function agentOverBudget(profile: AgentProfile): string | null {
  if (!profile.budgetUsd && !profile.budgetTokens) return null;
  const reached = over(db.usageOf('profile_id', profile.id, monthStart()), profile.budgetUsd, profile.budgetTokens);
  return reached && `${profile.name} has used ${reached}`;
}

/** Throws when a run by `profile` for `projectId` (null: not for a project) would go over a budget. */
export function assertBudget(projectId: number | null, profile: AgentProfile): void {
  const project = projectId == null ? null : projectOverBudget(projectId);
  if (project) throw new BudgetError('project', project);
  const agent = agentOverBudget(profile);
  if (agent) throw new BudgetError('agent', agent);
}
