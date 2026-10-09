/**
 * Who wrote what. Runs record the agent profile that did them; role messages
 * without one show the project's current profile for that role, and activity
 * from before profiles existed keeps the names it was shown with.
 */
import { createContext, useContext } from 'react';
import { JOB_LABELS, PROVIDER_LABELS, type AgentJob, type AgentProfile, type DriverName, type Project, type Subtask } from '../../server/types.ts';

/** Legacy worker ids (`worker-3`) mapped to the names they were shown with. */
const WORKER_NAMES = ['Alex', 'Jamie', 'Sam', 'Riley', 'Casey', 'Jordan', 'Taylor', 'Morgan'];

/** What each job sees and does, for the activity guide and message details. */
export const JOB_CONTEXT: Record<AgentJob, string> = {
  coordinator: 'The current card, its plan, dependencies, and repository. Assigns tasks, checks progress, and prepares the review handoff.',
  developer: 'An assigned implementation, fix or design task and its isolated worktree. Reports code changes, decisions and blockers. Design work goes to workers whose job title mentions design.',
  auditor: 'An assigned test or acceptance task and its isolated worktree. Reports test scenarios, scripts, and findings; recorded results show what actually ran.',
  senior: 'The combined card worktree and the current review lens. Reviews code and recommendations with read-only access.',
  assistant: 'Every project board, without repository access. Reports status, drafts Icebox cards, and passes your messages and decisions to coordinators when you ask.',
};

/** How roles are grouped for people. The Chief of Staff is shown on its own, above these. */
export const ROLE_GROUPS: { label: string; jobs: AgentJob[] }[] = [
  { label: 'Coordinators', jobs: ['coordinator'] },
  { label: 'Workers', jobs: ['developer'] },
  { label: 'Auditors', jobs: ['auditor'] },
  { label: 'Architects', jobs: ['senior'] },
  { label: 'Chiefs of Staff', jobs: ['assistant'] },
];

/** The title shown beside a profile's name: its job title, or its role. */
export const profileTitle = (profile: Pick<AgentProfile, 'title' | 'job'>) => profile.title || JOB_LABELS[profile.job];

export const providerLabel = (provider: DriverName) => (provider === 'simulated' ? 'Simulated' : PROVIDER_LABELS[provider]);

/** What a project's team runs on, e.g. "Simulated" or "Claude · Codex". */
export function teamProviders(project: Project, profiles: Iterable<AgentProfile>): { label: string; simulated: boolean } {
  const team = project.settings.team;
  const members = [...profiles].filter((p) => !p.archived && p.job !== 'assistant' && (!team.length || team.includes(p.id)));
  const used = [...new Set(members.map((p) => p.provider || 'simulated'))];
  return { label: used.map(providerLabel).join(' · ') || 'Simulated', simulated: used.every((p) => p === 'simulated') };
}

/** The profile that answers as the assistant: the first Chief of Staff. */
export function assistantOf(profiles: Iterable<AgentProfile>): AgentProfile | undefined {
  return [...profiles].filter((p) => !p.archived && p.job === 'assistant').sort((a, b) => a.id - b.id)[0];
}

export interface AgentDirectory {
  profiles: Map<number, AgentProfile>;
  projects: Map<number, Project>;
}

export const DirectoryContext = createContext<AgentDirectory>({ profiles: new Map(), projects: new Map() });
/** The project whose card is on screen, so role messages show that project's team. */
export const ProjectScope = createContext<number | null>(null);

export interface ResolvedAgent {
  name: string;
  title: string;
  context: string;
  imageUrl: string | null;
}

const ROLE_JOBS: Record<string, AgentJob> = { coordinator: 'coordinator', senior: 'senior', assistant: 'assistant' };

/** Mirrors the server: the team's first profile with the job, else anyone with it. */
function teamProfile(dir: AgentDirectory, projectId: number | null, job: AgentJob): AgentProfile | undefined {
  const all = [...dir.profiles.values()].sort((a, b) => a.id - b.id);
  const team = projectId != null ? dir.projects.get(projectId)?.settings.team ?? [] : [];
  const active = all.filter((p) => !p.archived);
  return active.find((p) => p.job === job && (job === 'assistant' || !team.length || team.includes(p.id))) ?? active.find((p) => p.job === job);
}

/** Title from an old worker's task, before roles were recorded on profiles; it keeps the label it was shown with. */
function legacyTitle(subtask?: Subtask): string {
  const title = subtask?.title.trim() ?? '';
  if (subtask?.kind === 'acceptance' || /^(?:tests?\b|write (?:the )?(?:tests?\b|acceptance\b)|qa\b)/i.test(title)) return JOB_LABELS.auditor;
  if (/^(?:design\b|wireframe\b|mockup\b|prototype\b)/i.test(title)) return 'Designer';
  return JOB_LABELS.developer;
}

export function resolveAgent(dir: AgentDirectory, projectId: number | null, actor: string, opts: { subtask?: Subtask; profileId?: number | null } = {}): ResolvedAgent {
  const assigned = opts.subtask ? ` Assigned task: ${opts.subtask.title}.` : '';
  const id = opts.profileId ?? opts.subtask?.profileId ?? null;
  const profile = (id != null ? dir.profiles.get(id) : undefined) ?? (ROLE_JOBS[actor] ? teamProfile(dir, projectId, ROLE_JOBS[actor]) : undefined);
  if (profile) {
    return { name: profile.name, title: profileTitle(profile), context: `${JOB_CONTEXT[profile.job]}${assigned}`, imageUrl: profile.imageUrl };
  }
  const worker = actor.match(/^worker-(\d+)$/);
  let name = actor;
  if (worker) {
    const n = Number(worker[1]);
    name = WORKER_NAMES[(n - 1) % WORKER_NAMES.length] ?? 'Alex';
    if (n > WORKER_NAMES.length) name += ` ${String.fromCharCode(65 + (Math.floor((n - 1) / WORKER_NAMES.length) % 26))}.`;
  }
  const title = ROLE_JOBS[actor] ? JOB_LABELS[ROLE_JOBS[actor]] : legacyTitle(opts.subtask);
  const job = (Object.keys(JOB_LABELS) as AgentJob[]).find((j) => JOB_LABELS[j] === title) ?? 'developer';
  return { name, title, context: `${JOB_CONTEXT[job]}${assigned}`, imageUrl: null };
}

/** The agent behind an actor id, resolved with the directory and project in scope. */
export function useAgent(actor: string, opts: { subtask?: Subtask; profileId?: number | null } = {}): ResolvedAgent {
  return resolveAgent(useContext(DirectoryContext), useContext(ProjectScope), actor, opts);
}

/** "Name · Job" for labels and filters. */
export function useAgentLabel(): (actor: string, opts?: { subtask?: Subtask; profileId?: number | null }) => string {
  const dir = useContext(DirectoryContext);
  const projectId = useContext(ProjectScope);
  return (actor, opts = {}) => {
    const agent = resolveAgent(dir, projectId, actor, opts);
    return `${agent.name} · ${agent.title}`;
  };
}
