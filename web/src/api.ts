/** Thin typed client for the factory API. */
import type {
  AgentProfile, Card, CardDetail, Context, FactoryState, JevStatus, UsageReport, Project, ProjectProcess, ProviderId, ProviderStatus, RunLimits, Settings, Skill, Stage, UsageTotals,
} from '../../server/types.ts';

export interface FolderListing {
  path: string;
  parent: string | null;
  home: string;
  git: boolean;
  dirs: { name: string; path: string; git: boolean }[];
  /** More folders exist than were listed. */
  truncated: boolean;
}

export interface SkillImport {
  added: string[];
  updated: string[];
  skipped: { where: string; reason: string }[];
}

export interface Backups {
  dir: string;
  keyFile: string;
  backups: { name: string; path: string; bytes: number; createdAt: number }[];
}

export type ProfileInput = Pick<AgentProfile, 'name' | 'job' | 'title' | 'provider' | 'context' | 'imageUrl' | 'model' | 'skillIds' | 'contextIds' | 'budgetUsd' | 'budgetTokens'>;

/** A context as the editor sends it. Secret values: a string replaces, null keeps the saved one, a missing name removes it. */
export interface ContextInput {
  name: string;
  description: string;
  transport: Context['transport'];
  folder: string;
  command: string;
  args: string[];
  cwd: string;
  envPassthrough: string[];
  url: string;
  bearerTokenEnv: string;
  envHeaders: Record<string, string>;
  env: Record<string, string | null>;
  headers: Record<string, string | null>;
  readOnly: boolean;
  enabled?: boolean;
}

/** This install's API token, written into the page by the server (see server/auth.ts). */
export const API_TOKEN = document.querySelector<HTMLMetaElement>('meta[name="factory-token"]')?.content ?? '';
const AUTH = { 'x-factory-token': API_TOKEN };

async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { ...AUTH, 'content-type': 'application/json' } : AUTH,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const api = {
  processes: (signal?: AbortSignal) => request<{ processes: ProjectProcess[] }>('GET', '/api/processes', undefined, signal),
  stopProcess: (id: string) => request<{ ok: boolean; disconnects: boolean }>('POST', '/api/processes/stop', { id }),
  state: () => request<FactoryState>('GET', '/api/state'),
  card: (id: number) => request<CardDetail>('GET', `/api/cards/${id}`),
  create: (body: { projectId: number; description: string; instructions: string; instructionsHash: string | null; parentId?: number | null }) =>
    request<Card>('POST', '/api/cards', body),
  update: (id: number, body: { description?: string; instructions?: string; instructionsHash?: string | null }) =>
    request<Card>('PATCH', `/api/cards/${id}`, body),
  remove: (id: number) => request<void>('DELETE', `/api/cards/${id}`),
  move: (id: number, stage: Stage, beforeId: number | null, afterId: number | null) =>
    request<Card>('POST', `/api/cards/${id}/move`, { stage, beforeId, afterId }),
  abort: (id: number) => request<Card>('POST', `/api/cards/${id}/abort`),
  merge: (id: number) => request<Card>('POST', `/api/cards/${id}/merge`),
  sync: (projectId: number, kind: 'pull' | 'push') => request<Card>('POST', `/api/projects/${projectId}/sync/${kind}`),
  projectUsage: (projectId: number) => request<{ byProfile: Record<number, UsageTotals>; total: UsageTotals | null }>('GET', `/api/projects/${projectId}/usage`),
  createProfile: (body: ProfileInput) => request<AgentProfile>('POST', '/api/profiles', body),
  updateProfile: (id: number, body: Partial<ProfileInput>) => request<AgentProfile>('PATCH', `/api/profiles/${id}`, body),
  removeProfile: (id: number) => request<void>('DELETE', `/api/profiles/${id}`),
  skill: (id: number) => request<{ skill: Skill; content: string; files: string[] }>('GET', `/api/skills/${id}`),
  importSkillFolder: (body: { source: string; skills: { where: string; files: { path: string; data: string }[] }[] }) =>
    request<SkillImport>('POST', '/api/skills/import/folder', body),
  importSkillGithub: (url: string) => request<SkillImport>('POST', '/api/skills/import/github', { url }),
  importSkillsSh: (ref: string) => request<SkillImport>('POST', '/api/skills/import/skills-sh', { ref }),
  removeSkill: (id: number) => request<void>('DELETE', `/api/skills/${id}`),
  hide: (id: number, hidden: boolean) => request<Card>('POST', `/api/cards/${id}/hide`, { hidden }),
  comment: (id: number, body: string, secrets: Record<string, string>) =>
    request<void>('POST', `/api/cards/${id}/comment`, { body, secrets }),
  approve: (id: number, note: string) => request<Card>('POST', `/api/cards/${id}/approve`, { note }),
  changes: (id: number, body: string) => request<Card>('POST', `/api/cards/${id}/changes`, { body }),
  resume: (id: number, body = '', secrets: Record<string, string> = {}) =>
    request<Card>('POST', `/api/cards/${id}/resume`, { body, secrets }),
  createProject: (body: { name: string; settings: Partial<Settings> }) => request<Project>('POST', '/api/projects', body),
  updateProject: (id: number, body: { name?: string; settings?: Partial<Settings> }) => request<Project>('PATCH', `/api/projects/${id}`, body),
  ask: (body: string) => request<void>('POST', '/api/assistant/messages', { body }),
  refreshProviders: () => request<ProviderStatus[]>('POST', '/api/providers/refresh'),
  setProvider: (id: ProviderId, enabled: boolean) => request<ProviderStatus[]>('PATCH', `/api/providers/${id}`, { enabled }),
  createContext: (body: ContextInput) => request<Context>('POST', '/api/contexts', body),
  updateContext: (id: number, body: Partial<ContextInput>) => request<Context>('PATCH', `/api/contexts/${id}`, body),
  removeContext: (id: number) => request<void>('DELETE', `/api/contexts/${id}`),
  checkContext: (id: number) => request<{ server: string; tools: string[]; files?: number }>('POST', `/api/contexts/${id}/check`),
  saveJev: (body: { apiKey?: string; model?: string; enabled?: boolean }) => request<JevStatus>('PUT', '/api/jev', body),
  removeJev: () => request<JevStatus>('DELETE', '/api/jev'),
  usageReport: (days: number, projectId?: number) =>
    request<UsageReport>('GET', `/api/usage/report?days=${days}${projectId === undefined ? '' : `&projectId=${projectId}`}`),
  setLimits: (limits: Partial<RunLimits>) => request<RunLimits>('PATCH', '/api/limits', limits),
  exportData: () => request<unknown>('GET', '/api/export'),
  importData: (bundle: unknown) => request<SkillImport>('POST', '/api/import', bundle),
  backups: () => request<Backups>('GET', '/api/backups'),
  backup: () => request<Backups['backups'][number]>('POST', '/api/backups'),
  chooseFolder: (start: string, title?: string) => request<{ path: string | null; supported: boolean }>('POST', '/api/fs/choose-folder', { start, title }),
  folders: (path: string, hidden: boolean) => request<FolderListing>('GET', `/api/fs/dirs?path=${encodeURIComponent(path)}${hidden ? '&hidden=1' : ''}`),

  async upload(file: File): Promise<string> {
    const res = await fetch('/api/uploads', { method: 'POST', headers: { ...AUTH, 'content-type': file.type }, body: file });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Upload failed');
    return data.url;
  },

  /** Streams instruction generation; resolves with the final document and its description hash. */
  async generateInstructions(
    description: string,
    projectId: number,
    cardId: number | null,
    on: { status: (text: string) => void; text: (chunk: string) => void },
    signal: AbortSignal,
    /** Write them even if Jev finds the description too vague. */
    force = false,
  ): Promise<{ instructions: string; hash: string } | { vague: string }> {
    const res = await fetch('/api/instructions', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ description, projectId, cardId, force }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? 'Generation failed');
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines.filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.type === 'status') on.status(event.text);
        else if (event.type === 'text') on.text(event.text);
        else if (event.type === 'error') throw new Error(event.text);
        else if (event.type === 'vague') return { vague: event.text };
        else if (event.type === 'done') return { instructions: event.instructions, hash: event.hash };
      }
    }
    throw new Error('Generation ended unexpectedly');
  },
};
