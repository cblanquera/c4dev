/**
 * Moving a factory's setup between machines: the skills and contexts
 * libraries, the agents (pictures included) and the projects with their
 * settings. Cards aren't exported (they live with their worktrees and
 * branches), and neither are secrets: contexts keep their variable and header
 * names, to be filled in again. Importing merges: skills and contexts by name,
 * agents by name (the Chief of Staff by role), projects by repository path.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db.ts';
import { HttpError } from './errors.ts';
import { assistantProfile, importSkills, saveProfile, skillDir, skillFiles } from './profiles.ts';
import { assertUsable } from './providers.ts';
import { cleanBudget } from './budget.ts';
import { saveContext } from './contexts.ts';
import { DATA_DIR, cleanLogo, listProjects, pickSettings, updateProject } from './settings.ts';
import { AGENT_JOBS, type AgentJob, type Context, type DriverName, type Settings } from './types.ts';

export const EXPORT_FORMAT = 'c4dev-export';
export const EXPORT_VERSION = 1;

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

export interface ExportedAgent {
  name: string;
  job: AgentJob;
  title: string;
  provider: DriverName;
  model: string;
  context: string;
  /** Skill names, matched against the library on import. */
  skills: string[];
  /** Context names, likewise. */
  contexts?: string[];
  /** The picture as a data URL. */
  image: string | null;
  budgetUsd?: number;
  budgetTokens?: number;
}

export interface FactoryExport {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  skills: { name: string; source: string; files: { path: string; data: string }[] }[];
  /** MCP servers without their secret values. */
  contexts?: Pick<Context, 'name' | 'description' | 'transport' | 'folder' | 'command' | 'args' | 'cwd' | 'envPassthrough' | 'url' | 'bearerTokenEnv' | 'envHeaders' | 'envNames' | 'headerNames' | 'readOnly' | 'enabled'>[];
  agents: ExportedAgent[];
  /** Settings with the team as agent names. */
  projects: { name: string; settings: Omit<Partial<Settings>, 'team'> & { team: string[] } }[];
}

export interface TransferResult {
  added: string[];
  updated: string[];
  skipped: { where: string; reason: string }[];
}

const uploadsDir = () => path.join(DATA_DIR, 'uploads');

function imageData(url: string | null): string | null {
  const file = url?.match(/^\/uploads\/([\w.-]+)$/)?.[1];
  const type = file && IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!file || !type || !fs.existsSync(path.join(uploadsDir(), file))) return null;
  return `data:${type};base64,${fs.readFileSync(path.join(uploadsDir(), file)).toString('base64')}`;
}

export function exportFactory(): FactoryExport {
  const skills = db.listSkills();
  const skillName = new Map(skills.map((s) => [s.id, s.name]));
  const agents = db.activeProfiles();
  const agentName = new Map(agents.map((p) => [p.id, p.name]));
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    skills: skills.map((s) => ({
      name: s.name, source: s.source,
      files: skillFiles(s.id).map((f) => ({ path: f, data: fs.readFileSync(path.join(skillDir(s.id), f)).toString('base64') })),
    })),
    contexts: db.listContexts().map((c) => ({
      name: c.name, description: c.description, transport: c.transport, folder: c.folder, command: c.command, args: c.args, cwd: c.cwd, envPassthrough: c.envPassthrough,
      url: c.url, bearerTokenEnv: c.bearerTokenEnv, envHeaders: c.envHeaders, envNames: c.envNames, headerNames: c.headerNames, readOnly: c.readOnly, enabled: c.enabled,
    })),
    agents: agents.map((p) => ({
      name: p.name, job: p.job, title: p.title, provider: p.provider, model: p.model, context: p.context,
      skills: p.skillIds.map((id) => skillName.get(id)).filter((n): n is string => !!n),
      contexts: p.contextIds.map((id) => db.getContext(id)?.name).filter((n): n is string => !!n),
      image: imageData(p.imageUrl),
      budgetUsd: p.budgetUsd, budgetTokens: p.budgetTokens,
    })),
    projects: listProjects().map((p) => ({
      name: p.name,
      // Uploaded logos travel inside the export, like agent pictures.
      settings: { ...p.settings, logoUrl: p.settings.logoUrl.startsWith('/uploads/') ? imageData(p.settings.logoUrl) ?? '' : p.settings.logoUrl, team: p.settings.team.map((id) => agentName.get(id)).filter((n): n is string => !!n) },
    })),
  };
}

interface ImportHooks {
  /** Saves a picture from a data URL, returning its /uploads URL, or null when it isn't an accepted image. */
  saveImage: (dataUrl: string) => string | null;
  /** Creates a project the way the API does (checking its repository). */
  createProject: (name: string, settings: Partial<Settings>) => Promise<void>;
  /** Tells a project's coordinator its settings changed. */
  projectChanged: (id: number) => void;
}

const failure = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function importFactory(input: unknown, hooks: ImportHooks): Promise<TransferResult> {
  const data = input as Partial<FactoryExport> | null;
  if (data?.format !== EXPORT_FORMAT) throw new HttpError(400, 'Not a factory export file');
  if (typeof data.version !== 'number' || data.version > EXPORT_VERSION) throw new HttpError(400, 'This export is from a newer version of the factory');
  const result: TransferResult = { added: [], updated: [], skipped: [] };

  for (const skill of Array.isArray(data.skills) ? data.skills : []) {
    const files = (Array.isArray(skill?.files) ? skill.files : []).map((f) => ({ path: String(f.path), data: Buffer.from(String(f.data), 'base64') }));
    const done = importSkills([{ where: String(skill?.name ?? ''), files }], String(skill?.source || 'Import'));
    result.added.push(...done.added.map((n) => `skill ${n}`));
    result.updated.push(...done.updated.map((n) => `skill ${n}`));
    result.skipped.push(...done.skipped.map((s) => ({ ...s, where: `skill ${s.where}` })));
  }

  for (const context of Array.isArray(data.contexts) ? data.contexts : []) {
    const where = `context ${context?.name ?? '?'}`;
    try {
      const existing = db.listContexts().find((c) => c.name.toLowerCase() === String(context.name).toLowerCase());
      const saved = existing ? db.contextSecrets(existing.id) : { env: {}, headers: {} };
      // Values never travel: saved ones are kept, new names start empty for the user to fill in.
      const keep = (names: unknown, values: Record<string, string>) => Object.fromEntries((Array.isArray(names) ? names : []).map((n) => [String(n), n in values ? null : '']));
      saveContext({ ...context, env: keep(context.envNames, saved.env), headers: keep(context.headerNames, saved.headers) }, existing?.id);
      (existing ? result.updated : result.added).push(where);
    } catch (err) {
      result.skipped.push({ where, reason: failure(err) });
    }
  }

  const skillIds = new Map(db.listSkills().map((s) => [s.name, s.id]));
  const contextIds = new Map(db.listContexts().map((c) => [c.name, c.id]));
  for (const agent of Array.isArray(data.agents) ? data.agents : []) {
    const where = `agent ${agent?.name ?? '?'}`;
    try {
      if (!AGENT_JOBS.includes(agent.job)) throw new Error(`unknown role ${agent.job}`);
      let provider: DriverName = agent.provider || 'simulated';
      try {
        assertUsable(provider);
      } catch {
        result.skipped.push({ where: `${where}'s provider`, reason: `${provider} isn't switched on here, so it runs on Simulated` });
        provider = 'simulated';
      }
      const existing = agent.job === 'assistant' ? assistantProfile() : db.activeProfiles().find((p) => p.name === agent.name && p.job !== 'assistant');
      const fields = {
        name: agent.name, job: agent.job, title: agent.title, provider, model: provider === 'simulated' ? '' : agent.model, context: agent.context,
        skillIds: (agent.skills ?? []).map((n) => skillIds.get(n)).filter((id): id is number => id != null),
        // Exports from before contexts existed leave an agent's contexts as they are.
        contextIds: agent.contexts ? agent.contexts.map((n) => contextIds.get(n)).filter((id): id is number => id != null) : existing?.contextIds ?? [],
        imageUrl: agent.image ? hooks.saveImage(agent.image) : null,
        budgetUsd: agent.budgetUsd ?? 0, budgetTokens: agent.budgetTokens ?? 0,
      };
      saveProfile(existing ? { ...existing, ...fields } : fields, existing?.id);
      (existing ? result.updated : result.added).push(where);
    } catch (err) {
      result.skipped.push({ where, reason: failure(err) });
    }
  }

  const agentIds = new Map(db.activeProfiles().map((p) => [p.name, p.id]));
  for (const project of Array.isArray(data.projects) ? data.projects : []) {
    const where = `project ${project?.name ?? '?'}`;
    try {
      const { team = [], ...rest } = project.settings ?? { team: [] };
      const settings: Partial<Settings> = { ...pickSettings(rest), team: team.map((n) => agentIds.get(n)).filter((id): id is number => id != null) };
      if (typeof settings.logoUrl === 'string') settings.logoUrl = settings.logoUrl.startsWith('data:') ? hooks.saveImage(settings.logoUrl) ?? '' : cleanLogo(settings.logoUrl);
      if (settings.budgetUsd !== undefined) settings.budgetUsd = cleanBudget(settings.budgetUsd, 'usd');
      if (settings.budgetTokens !== undefined) settings.budgetTokens = cleanBudget(settings.budgetTokens, 'tokens');
      if (!settings.repoPath) throw new Error('no project path');
      const repoPath = path.resolve(settings.repoPath);
      const existing = listProjects().find((p) => path.resolve(p.settings.repoPath) === repoPath);
      if (existing) {
        const { repoPath: _same, ...changes } = settings;
        updateProject(existing.id, { name: project.name || existing.name, settings: changes });
        hooks.projectChanged(existing.id);
        result.updated.push(where);
      } else {
        await hooks.createProject(String(project.name ?? '').trim(), { ...settings, repoPath });
        result.added.push(where);
      }
    } catch (err) {
      result.skipped.push({ where, reason: failure(err) });
    }
  }
  return result;
}
