/**
 * Agent profiles and their skills. A profile is who does a run: its brief is
 * added to the run's instructions and its skills are loaded into the session
 * through a per-profile plugin folder outside every repository. Projects pick
 * a team of profiles; runs are assigned to the team member with the right job.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db.ts';
import { DATA_DIR, listProjects, runLimits, settings, updateSettings } from './settings.ts';
import { HttpError } from './errors.ts';
import { assertUsable } from './providers.ts';
import { agentOverBudget, cleanBudget } from './budget.ts';
import { AGENT_JOBS, JOB_LABELS, PROVIDERS, type AgentJob, type AgentProfile, type DriverName, type RunLimits, type Skill, type Subtask } from './types.ts';

const SKILLS_DIR = path.join(DATA_DIR, 'skills');
const PLUGINS_DIR = path.join(DATA_DIR, 'profiles');
const MAX_SKILL_MD_BYTES = 200_000;
const MAX_SKILL_BYTES = 5_000_000;
const MAX_SKILL_FILES = 300;

/** Jobs every project needs; removing their last profile is refused. Auditors fall back to workers. */
const REQUIRED_JOBS: AgentJob[] = ['coordinator', 'developer', 'senior', 'assistant'];

/** The starting team: the names the board has always used, so existing activity keeps its faces. */
const DEFAULT_PROFILES: { name: string; job: AgentJob; title: string; context: string }[] = [
  { name: 'Grace Hopper', job: 'coordinator', title: '', context: 'Keep plans small and measurable. Prefer parallel subtasks that touch different files.' },
  { name: 'Linus Torvalds', job: 'senior', title: '', context: 'Be direct. Only raise points worth fixing; approve when what remains is polish.' },
  { name: 'Alex', job: 'developer', title: '', context: '' },
  { name: 'Jamie', job: 'developer', title: '', context: '' },
  { name: 'Sam', job: 'developer', title: '', context: '' },
  { name: 'Casey', job: 'developer', title: 'Designer', context: 'Favour clear layouts, accessible contrast and mobile-first interactions.' },
  { name: 'Riley', job: 'auditor', title: '', context: 'Cover the main journey first, then edge cases. Test on desktop and a phone viewport.' },
  { name: 'Ada Lovelace', job: 'assistant', title: '', context: '' },
];

/** What a driver needs to act as a profile. */
export interface RunProfile {
  id: number;
  name: string;
  job: AgentJob;
  /** The job title, or the role when none is set. */
  title: string;
  context: string;
  model: string;
  skills: string[];
  /** A local plugin folder holding this profile's skills, or null without skills. */
  pluginDir: string | null;
  /** Caps on the run; drivers stop a run that reaches one and report it as a failure. */
  limits: RunLimits;
}

export function seedProfiles(): void {
  if (!db.listProfiles().length) {
    for (const p of DEFAULT_PROFILES) db.createProfile({ ...p, provider: 'simulated', imageUrl: null, model: '', skillIds: [], budgetUsd: 0, budgetTokens: 0 });
  }
  // The assistant always runs as someone.
  if (!db.profilesWithJob('assistant').length) {
    db.createProfile({ ...DEFAULT_PROFILES.find((p) => p.job === 'assistant')!, provider: 'simulated', imageUrl: null, model: '', skillIds: [], budgetUsd: 0, budgetTokens: 0 });
  }
  migrateProviders();
}

/**
 * Before agents chose their own provider, projects did (and the assistant had
 * its own setting). Agents without one take what they ran on.
 */
function migrateProviders(): void {
  const pending = db.listProfiles().filter((p) => !p.provider);
  if (!pending.length) return;
  const stored = db.loadSettings();
  const project = (db.listProjectRows()[0]?.settings ?? {}) as Record<string, unknown>;
  const legacy = (key: string) => project[key] ?? stored[key];
  const valid = (v: unknown): DriverName => (v === 'simulated' || (PROVIDERS as readonly unknown[]).includes(v) ? v as DriverName : 'simulated');
  for (const p of pending) {
    const assistant = p.job === 'assistant';
    const provider = valid(assistant ? stored['assistant.driver'] : legacy('driver'));
    const model = String((assistant ? stored['assistant.model'] : legacy(p.job === 'senior' ? 'seniorModel' : 'model')) ?? '');
    db.updateProfile(p.id, { ...p, provider, model: p.model || (provider === 'simulated' ? '' : model) });
  }
}

// ------------------------------------------------------------ skills

/** The `name:` and `description:` of a SKILL.md's frontmatter. */
export function parseSkill(content: string): { name: string; description: string } {
  const front = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  const field = (key: string) => front.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '') ?? '';
  return { name: field('name'), description: field('description') };
}

export const skillSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
export const skillDir = (id: number) => path.join(SKILLS_DIR, String(id));
/** Skill entry files go by SKILL.md; skills.md and lower case are accepted on import. */
export const isSkillFile = (name: string) => /^skills?\.md$/i.test(name);

/** One file of a skill, relative to the skill's folder. */
export interface SkillFile {
  path: string;
  data: Buffer;
}

export interface ImportResult {
  added: string[];
  updated: string[];
  skipped: { where: string; reason: string }[];
}

/** A relative path that stays inside the skill folder, or null. */
function safePath(raw: string): string | null {
  const clean = path.posix.normalize(raw.replaceAll('\\', '/')).replace(/^\.\//, '');
  if (!clean || clean === '.' || clean.startsWith('../') || clean === '..' || path.posix.isAbsolute(clean) || /(^|\/)\.git(\/|$)/.test(clean)) return null;
  return clean;
}

/**
 * Stores a skill folder: a SKILL.md at its root naming the skill in its
 * frontmatter, plus any files it uses. A skill with the same name is replaced
 * when `onClash` is 'update' (re-importing), or refused.
 */
export function saveSkillFiles(files: SkillFile[], source: string, onClash: 'update' | 'reject'): { skill: Skill; status: 'added' | 'updated' } {
  const clean: SkillFile[] = [];
  for (const file of files) {
    const rel = safePath(file.path);
    if (!rel) throw new HttpError(400, `Unsafe path in skill: ${file.path}`);
    clean.push({ path: isSkillFile(rel) ? 'SKILL.md' : rel, data: file.data });
  }
  const entry = clean.find((f) => f.path === 'SKILL.md');
  if (!entry) throw new HttpError(400, 'A skill needs a SKILL.md at the top of its folder');
  if (entry.data.length > MAX_SKILL_MD_BYTES) throw new HttpError(413, 'SKILL.md files are limited to 200 KB');
  if (clean.length > MAX_SKILL_FILES) throw new HttpError(413, `Skills are limited to ${MAX_SKILL_FILES} files`);
  if (clean.reduce((n, f) => n + f.data.length, 0) > MAX_SKILL_BYTES) throw new HttpError(413, 'Skills are limited to 5 MB');
  const { name, description } = parseSkill(entry.data.toString('utf8'));
  if (!skillSlug(name)) throw new HttpError(400, 'A SKILL.md needs frontmatter with a name, e.g. "name: release-notes"');
  const clash = db.listSkills().find((s) => skillSlug(s.name) === skillSlug(name));
  if (clash && onClash === 'reject') throw new HttpError(409, `A skill called "${clash.name}" already exists`);
  const input = { name, description, source, fileCount: clean.length };
  const skill = clash ? db.updateSkillRow(clash.id, input)! : db.insertSkill(input);
  const dir = skillDir(skill.id);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const file of clean) {
    fs.mkdirSync(path.dirname(path.join(dir, file.path)), { recursive: true });
    fs.writeFileSync(path.join(dir, file.path), file.data);
  }
  for (const profile of db.activeProfiles()) if (profile.skillIds.includes(skill.id)) buildPlugin(profile);
  return { skill, status: clash ? 'updated' : 'added' };
}

/** A single uploaded SKILL.md. */
export function saveSkill(content: string): Skill {
  return saveSkillFiles([{ path: 'SKILL.md', data: Buffer.from(content) }], 'Upload', 'reject').skill;
}

/** Imports several skills, reporting each instead of failing the batch. */
export function importSkills(bundles: { where: string; files: SkillFile[] }[], source: string): ImportResult {
  const result: ImportResult = { added: [], updated: [], skipped: [] };
  for (const bundle of bundles) {
    try {
      const { skill, status } = saveSkillFiles(bundle.files, source, 'update');
      result[status].push(skill.name);
    } catch (err) {
      result.skipped.push({ where: bundle.where || '(top folder)', reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

export function skillContent(id: number): string {
  if (!db.getSkill(id)) throw new HttpError(404, `Skill ${id} not found`);
  const file = path.join(skillDir(id), 'SKILL.md');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** Every file in a skill, relative to its folder. */
export function skillFiles(id: number): string[] {
  const dir = skillDir(id);
  if (!fs.existsSync(dir)) return [];
  return (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
}

export function deleteSkill(id: number): void {
  if (!db.getSkill(id)) throw new HttpError(404, `Skill ${id} not found`);
  for (const profile of db.activeProfiles()) {
    if (profile.skillIds.includes(id)) saveProfile({ ...profile, skillIds: profile.skillIds.filter((s) => s !== id) }, profile.id);
  }
  db.deleteSkillRow(id);
  fs.rmSync(skillDir(id), { recursive: true, force: true });
}

// ------------------------------------------------------------ profiles

const pluginDir = (profileId: number) => path.join(PLUGINS_DIR, String(profileId));

/** Rebuilds the plugin folder that carries a profile's skills into its sessions. */
function buildPlugin(profile: AgentProfile): void {
  const dir = pluginDir(profile.id);
  fs.rmSync(dir, { recursive: true, force: true });
  const skills = profile.skillIds.map((id) => db.getSkill(id)).filter((s): s is Skill => !!s);
  if (!skills.length) return;
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: `factory-profile-${profile.id}`, version: '1.0.0', description: `Skills for ${profile.name}`,
  }, null, 2));
  for (const skill of skills) {
    if (fs.existsSync(skillDir(skill.id))) fs.cpSync(skillDir(skill.id), path.join(dir, 'skills', skillSlug(skill.name)), { recursive: true });
  }
}

function cleanInput(input: Partial<db.ProfileInput>): db.ProfileInput {
  const name = String(input.name ?? '').trim();
  if (!name) throw new HttpError(400, 'A profile needs a name');
  if (!AGENT_JOBS.includes(input.job as AgentJob)) throw new HttpError(400, 'Unknown job');
  const known = new Set(db.listSkills().map((s) => s.id));
  const provider = (input.provider || 'simulated') as DriverName;
  assertUsable(provider);
  const imageUrl = typeof input.imageUrl === 'string' && /^\/uploads\/[\w.-]+$/.test(input.imageUrl) ? input.imageUrl : null;
  return {
    name: name.slice(0, 80),
    job: input.job as AgentJob,
    title: String(input.title ?? '').trim().slice(0, 60),
    provider,
    context: String(input.context ?? '').slice(0, 20_000),
    imageUrl,
    model: String(input.model ?? '').trim(),
    skillIds: [...new Set((input.skillIds ?? []).map(Number))].filter((id) => known.has(id)),
    budgetUsd: cleanBudget(input.budgetUsd, 'usd'),
    budgetTokens: cleanBudget(input.budgetTokens, 'tokens'),
  };
}

/**
 * Creates or updates a profile. A job that projects rely on can't be left
 * without anyone, and the assistant is one agent: nobody else becomes Chief of
 * Staff and the Chief of Staff keeps that role.
 */
export function saveProfile(input: Partial<db.ProfileInput>, id?: number): AgentProfile {
  const clean = cleanInput(input);
  const existing = id != null ? db.getProfile(id) : undefined;
  if (id != null && (!existing || existing.archived)) throw new HttpError(404, `Profile ${id} not found`);
  const chief = assistantProfile();
  if (clean.job === 'assistant' && existing?.job !== 'assistant') throw new HttpError(409, `There's only one Chief of Staff: ${chief.name}`);
  if (existing?.id === chief.id && clean.job !== 'assistant') throw new HttpError(409, `${chief.name} is the Chief of Staff; that role can't change`);
  if (existing && existing.job !== clean.job) assertNotLast(existing);
  const profile = existing ? db.updateProfile(existing.id, clean)! : db.createProfile(clean);
  buildPlugin(profile);
  return profile;
}

export function removeProfile(id: number): void {
  const profile = db.getProfile(id);
  if (!profile || profile.archived) throw new HttpError(404, `Profile ${id} not found`);
  if (profile.id === assistantProfile().id) throw new HttpError(409, `${profile.name} is the Chief of Staff, who runs the assistant, and can't be deleted`);
  assertNotLast(profile);
  for (const project of listProjects()) {
    if (project.settings.team.includes(id)) updateSettings(project.id, { team: project.settings.team.filter((p) => p !== id) });
  }
  db.archiveProfile(id);
  fs.rmSync(pluginDir(id), { recursive: true, force: true });
}

function assertNotLast(profile: AgentProfile): void {
  if (REQUIRED_JOBS.includes(profile.job) && db.profilesWithJob(profile.job).length <= 1) {
    throw new HttpError(409, `${profile.name} is the only ${JOB_LABELS[profile.job].toLowerCase()}; add another first`);
  }
}

/** Projects whose team names this profile; an empty team means everyone. */
export function projectsOf(profileId: number): number[] {
  return listProjects().filter((p) => !p.settings.team.length || p.settings.team.includes(profileId)).map((p) => p.id);
}

// ------------------------------------------------------------ assignment

/**
 * Who a subtask needs: tests and acceptance scripts go to an auditor, the rest
 * to a worker. Design work prefers workers whose job title mentions design.
 */
export function needsFor(subtask: Pick<Subtask, 'kind' | 'title'>): { job: AgentJob; prefer?: RegExp } {
  const title = subtask.title.trim();
  if (subtask.kind === 'acceptance' || /^(?:tests?\b|write (?:the )?(?:tests?\b|acceptance\b)|qa\b)/i.test(title)) return { job: 'auditor' };
  if (/^(?:design\b|wireframe\b|mockup\b|prototype\b)/i.test(title)) return { job: 'developer', prefer: /design/i };
  return { job: 'developer' };
}

/** The project's team: its chosen profiles, or everyone when none are chosen. */
export function teamOf(projectId: number): AgentProfile[] {
  const team = settings(projectId).team;
  const all = db.activeProfiles();
  const chosen = team.length ? all.filter((p) => team.includes(p.id)) : all;
  return chosen.length ? chosen : all;
}

/**
 * Who does a job on a project: a preferred title first (e.g. a designer for
 * design work), then the least busy. Without a team member for the job,
 * auditors fall back to workers, then to anyone with the role, so work never
 * stalls on a missing role.
 */
export function pickProfile(projectId: number, job: AgentJob, busy: Map<number, number> = new Map(), prefer?: RegExp): AgentProfile {
  const team = teamOf(projectId);
  const candidates = [
    team.filter((p) => p.job === job),
    job === 'auditor' ? team.filter((p) => p.job === 'developer') : [],
    db.profilesWithJob(job),
    db.profilesWithJob('developer'),
  ].find((list) => list.length)!;
  // Agents over their monthly budget are passed over while someone else can do the work.
  const rank = (p: AgentProfile) => (agentOverBudget(p) ? 2 : prefer && prefer.test(p.title) ? 0 : 1);
  return [...candidates].sort((a, b) => rank(a) - rank(b) || (busy.get(a.id) ?? 0) - (busy.get(b.id) ?? 0) || a.id - b.id)[0];
}

/** The assistant answers for every project, so it's the first Chief of Staff profile. */
export function assistantProfile(): AgentProfile {
  return db.profilesWithJob('assistant')[0];
}

export function runProfile(profile: AgentProfile): RunProfile {
  const skills = profile.skillIds.map((id) => db.getSkill(id)?.name).filter((n): n is string => !!n);
  const dir = pluginDir(profile.id);
  return {
    id: profile.id, name: profile.name, job: profile.job, title: profile.title || JOB_LABELS[profile.job], context: profile.context, model: profile.model, skills,
    pluginDir: skills.length && fs.existsSync(dir) ? dir : null,
    limits: runLimits(),
  };
}
