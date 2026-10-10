/** HTTP API + SSE stream. Business rules for manual moves live here. */
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as db from './db.ts';
import { subscribe } from './events.ts';
import { HttpError, backlogBlocker } from './coordinator.ts';
import type { Factory } from './factory.ts';
import type { Assistant } from './assistant.ts';
import {
  DATA_DIR, createProject, defaultSettings, getProject, listProjects, pickSettings, refreshRemote, settings, updateProject,
} from './settings.ts';
import { deleteSkill, importSkills, pickProfile, removeProfile, runProfile, saveProfile, saveSkill, skillContent, skillFiles } from './profiles.ts';
import { importFromGithub, importFromSkillsSh } from './skill-import.ts';
import { providerStatuses, refreshProviders, setProviderEnabled } from './providers.ts';

/** Folder imports and factory imports carry whole skill folders, so they get a larger body limit than the rest of the API. */
const LARGE_BODIES = ['/api/skills/import/folder', '/api/import'];
const largeJson = express.json({ limit: '60mb' });
/** Folders listed per request by the folder browser; type a path for anything beyond. */
const MAX_FOLDERS = 5000;
import { assertRepo } from './git.ts';
import { STAGES, type CardDetail, type FactoryState, type Settings, type Stage } from './types.ts';
import { deliveryNotes } from './delivery.ts';
import { DevmetricsProcesses, type ProcessManager } from './processes.ts';
import { guard, withToken } from './auth.ts';
import { exportFactory, importFactory } from './transfer.ts';
import { KEY_FILE } from './crypto.ts';

const UPLOAD_TYPES: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg',
};

const asyncRoute = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

function cardId(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Bad card id');
  return id;
}

function mustGet(id: number) {
  const card = db.getCard(id);
  if (!card) throw new HttpError(404, `Card #${id} not found`);
  return card;
}

function mustGetProject(id: unknown) {
  const project = getProject(Number(id));
  if (!project) throw new HttpError(404, `Project ${id} not found`);
  return project;
}

/** A project needs a name and its own git repository. Resolves `patch.repoPath` in place. */
async function validateProject(name: string, patch: Partial<Settings>, selfId: number | null): Promise<void> {
  if (!name) throw new HttpError(400, 'Project name is required');
  if (patch.remote !== undefined && !/^[\w.-]*$/.test(String(patch.remote))) throw new HttpError(400, 'A remote name has only letters, digits, dots, dashes and underscores');
  if (patch.team !== undefined) {
    if (!Array.isArray(patch.team)) throw new HttpError(400, 'The team is a list of profile ids');
    const known = new Set(db.activeProfiles().map((p) => p.id));
    patch.team = [...new Set(patch.team.map(Number))].filter((id) => known.has(id));
  }
  if (patch.repoPath === undefined) return;
  // path.resolve('') is the working directory, so an empty path must be rejected first.
  if (!String(patch.repoPath).trim()) throw new HttpError(400, 'Project path is required');
  patch.repoPath = path.resolve(String(patch.repoPath).trim());
  if (selfId != null && patch.repoPath === path.resolve(settings(selfId).repoPath)) return;
  try {
    await assertRepo(patch.repoPath);
  } catch {
    throw new HttpError(400, `Not a git repository: ${patch.repoPath}`);
  }
  if (listProjects().some((p) => p.id !== selfId && path.resolve(p.settings.repoPath) === patch.repoPath)) {
    throw new HttpError(409, 'Another project already uses this repository');
  }
}

/** Roots for every project, so background processes in any repository are listed. */
const projectRoots = () => [process.cwd(), ...listProjects().map((p) => p.settings.repoPath), path.join(DATA_DIR, 'worktrees')];

interface AppOptions {
  /** This install's API token (see auth.ts). */
  token: string;
  processes?: ProcessManager;
}

export function createApp(factory: Factory, assistant: Assistant, { token, processes = new DevmetricsProcesses(projectRoots) }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.use(guard(token));
  const uploadsDir = path.join(DATA_DIR, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const json = express.json({ limit: '2mb' });
  app.use((req, res, next) => (LARGE_BODIES.includes(req.path) ? largeJson(req, res, next) : json(req, res, next)));
  app.use('/uploads', express.static(uploadsDir, { maxAge: '1y', immutable: true }));

  app.get('/api/state', (_req, res) => {
    const state: FactoryState = {
      projects: listProjects(),
      cards: db.listCards(),
      projectDefaults: defaultSettings(),
      assistant: { messages: db.listAssistantMessages(), busy: assistant.busy },
      profiles: db.listProfiles(),
      skills: db.listSkills(),
      providers: providerStatuses(),
      usage: { byProject: db.usageBy('project_id'), byProfile: db.usageBy('profile_id') },
    };
    res.json(state);
  });

  app.get('/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const unsubscribe = subscribe((event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  // ---------------------------------------------------------------- cards

  app.get('/api/cards/:id', (req, res) => {
    const card = mustGet(cardId(req));
    const subtasks = db.listSubtasks(card.id);
    const logs = db.listLogs(card.id);
    const comments = db.listComments(card.id);
    const detail: CardDetail = {
      card,
      subtasks, logs, comments,
      deliveryNotes: db.redactSecrets(card.id, deliveryNotes(card, subtasks, logs, comments, settings(card.projectId))),
      chatBusy: factory.forCard(card.id).isChatBusy(card.id),
      usage: db.cardUsage(card.id),
    };
    res.json(detail);
  });

  app.post('/api/cards', (req, res) => {
    const { projectId, description, instructions = '', instructionsHash = null, parentId = null } = req.body ?? {};
    const project = mustGetProject(projectId);
    if (typeof description !== 'string' || !description.trim()) throw new HttpError(400, 'Description is required');
    res.status(201).json(db.createCard({
      projectId: project.id,
      description,
      instructions,
      instructionsHash: instructionsHash === 'current' ? db.hashText(description) : instructionsHash,
      parentId,
    }));
  });

  app.patch('/api/cards/:id', (req, res) => {
    const card = mustGet(cardId(req));
    if (card.stage !== 'icebox') throw new HttpError(409, 'Only cards in the Icebox can be edited');
    const { description, instructions, instructionsHash } = req.body ?? {};
    const nextDescription = typeof description === 'string' ? description : card.description;
    const updated = db.updateCard(card.id, {
      ...(typeof description === 'string' ? { description } : {}),
      ...(typeof instructions === 'string' ? { instructions } : {}),
      ...(instructionsHash !== undefined ? { instructionsHash: instructionsHash === 'current' ? db.hashText(nextDescription) : instructionsHash } : {}),
    });
    // Saving parks the card in the Icebox (it already is) at the top.
    res.json(updated);
  });

  app.delete('/api/cards/:id', (req, res) => {
    const card = mustGet(cardId(req));
    if (card.stage !== 'icebox') throw new HttpError(409, 'Only Icebox cards can be deleted; abort it first');
    db.updateCard(card.id, { hidden: true });
    res.status(204).end();
  });

  /** Manual drag & drop. Only Icebox ⇄ Backlog moves and reordering within them are allowed. */
  app.post('/api/cards/:id/move', asyncRoute(async (req, res) => {
    const card = mustGet(cardId(req));
    const { stage, beforeId = null, afterId = null } = req.body ?? {};
    if (!STAGES.includes(stage)) throw new HttpError(400, 'Unknown stage');
    if (card.kind !== 'task') throw new HttpError(409, 'Merge, pull and push cards are moved by the coordinator; abort to cancel one');
    const to = stage as Stage;
    const from = card.stage;
    const allowed = (from === to && (to === 'icebox' || to === 'backlog')) || (from === 'icebox' && to === 'backlog') || (from === 'backlog' && to === 'icebox');
    if (!allowed) throw new HttpError(409, `Cards can't be moved from ${from} to ${to} by hand`);

    if (from === 'icebox' && to === 'backlog') {
      const blocker = backlogBlocker(card);
      if (blocker) throw new HttpError(409, blocker);
    }
    const coordinator = factory.forCard(card.id);
    if (from === 'backlog' && to === 'icebox' && coordinator.isBusy(card.id)) {
      await coordinator.abort(card.id);
    }
    const position = db.positionBetween(card.projectId, to, beforeId, afterId);
    const moved = db.moveCard(card.id, to, position, 'moved by you')!;
    if (to === 'backlog' && from !== 'backlog') db.setStatus(card.id, 'queued', 'Queued for the coordinator');
    if (to === 'icebox' && from !== 'icebox') db.setStatus(card.id, 'idle', '');
    coordinator.tick();
    res.json(moved);
  }));

  app.post('/api/cards/:id/merge', (req, res) => {
    res.json(factory.forCard(cardId(req)).requestMerge(cardId(req)));
  });

  app.post('/api/cards/:id/abort', asyncRoute(async (req, res) => {
    res.json(await factory.forCard(cardId(req)).abort(cardId(req)));
  }));

  app.post('/api/cards/:id/hide', (req, res) => {
    const card = mustGet(cardId(req));
    res.json(db.updateCard(card.id, { hidden: req.body?.hidden !== false }));
  });

  app.post('/api/cards/:id/comment', (req, res) => {
    const { body = '', secrets = {} } = req.body ?? {};
    if (typeof body !== 'string' || !secrets || typeof secrets !== 'object' || Array.isArray(secrets)) throw new HttpError(400, 'Invalid message');
    if (!String(body).trim() && !Object.keys(secrets).length) throw new HttpError(400, 'Say something');
    factory.forCard(cardId(req)).comment(cardId(req), String(body), secrets);
    res.status(202).json({ ok: true });
  });

  // ---------------------------------------------------------------- project processes

  app.get('/api/processes', asyncRoute(async (_req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const running = await processes.list(controller.signal);
    controller.signal.throwIfAborted();
    res.json({ processes: running });
  }));

  app.post('/api/processes/stop', asyncRoute(async (req, res) => {
    const id = req.body?.id;
    if (typeof id !== 'string' || !id.trim()) throw new HttpError(400, 'Process id is required');
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const running = await processes.list(controller.signal);
    controller.signal.throwIfAborted();
    const processToStop = running.find((item) => item.id === id);
    if (!processToStop) throw new HttpError(404, 'Process not found in this project');
    if (processToStop.currentServer) {
      // Acknowledge before shutting down the API serving this request.
      res.on('finish', () => { void processes.stop(id, new AbortController().signal).catch((err) => console.error(err.message)); });
      return res.json({ ok: true, disconnects: true });
    }
    await processes.stop(id, controller.signal);
    controller.signal.throwIfAborted();
    res.json({ ok: true, disconnects: false });
  }));

  app.post('/api/cards/:id/approve', asyncRoute(async (req, res) => {
    await factory.forCard(cardId(req)).approve(cardId(req), String(req.body?.note ?? ''));
    res.json(db.getCard(cardId(req)));
  }));

  app.post('/api/cards/:id/changes', (req, res) => {
    const body = String(req.body?.body ?? '').trim();
    if (!body) throw new HttpError(400, 'Describe the changes you want');
    factory.forCard(cardId(req)).requestChanges(cardId(req), body);
    res.json(db.getCard(cardId(req)));
  });

  app.post('/api/cards/:id/resume', (req, res) => {
    factory.forCard(cardId(req)).resumeFromDeliverables(cardId(req), String(req.body?.body ?? ''), req.body?.secrets ?? {});
    res.json(db.getCard(cardId(req)));
  });

  // ---------------------------------------------------------------- instructions

  /** Streams NDJSON events: {type:'status'|'text', text} … {type:'done', instructions, hash}. */
  app.post('/api/instructions', asyncRoute(async (req, res) => {
    const description = String(req.body?.description ?? '');
    if (!description.trim()) throw new HttpError(400, 'Write a description first');
    const project = mustGetProject(req.body?.projectId);
    const selfId = Number(req.body?.cardId) || undefined;
    const references = db.parseTags(description, selfId).map((id) => db.getCard(id)).filter((c) => !!c);
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
    const send = (obj: unknown) => res.write(`${JSON.stringify(obj)}\n`);
    try {
      const writer = pickProfile(project.id, 'coordinator');
      const instructions = await factory.driver(writer.provider).generateInstructions(
        { description, references, repoPath: project.settings.repoPath },
        (e) => send(e),
        {
          signal: controller.signal,
          profile: runProfile(writer),
          usage: (u) => db.addUsage({ ...u, projectId: project.id, cardId: selfId ?? null, profileId: writer.id }),
        },
      );
      send({ type: 'done', instructions, hash: db.hashText(description) });
    } catch (err) {
      if (!controller.signal.aborted) send({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    }
    res.end();
  }));

  // ---------------------------------------------------------------- uploads

  app.post('/api/uploads', express.raw({ type: Object.keys(UPLOAD_TYPES), limit: '15mb' }), (req, res) => {
    const ext = UPLOAD_TYPES[String(req.headers['content-type'])];
    if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(415, 'Upload a PNG, JPEG, GIF, WebP or SVG image');
    const file = `${randomUUID()}${ext}`;
    fs.writeFileSync(path.join(uploadsDir, file), req.body);
    res.status(201).json({ url: `/uploads/${file}` });
  });

  /** A picture from a data URL (imports), saved like an upload. */
  function saveImage(dataUrl: string): string | null {
    const m = dataUrl.match(/^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/);
    const ext = m && UPLOAD_TYPES[m[1]];
    if (!m || !ext) return null;
    const data = Buffer.from(m[2], 'base64');
    if (!data.length || data.length > 15 * 1024 * 1024) return null;
    const file = `${randomUUID()}${ext}`;
    fs.writeFileSync(path.join(uploadsDir, file), data);
    return `/uploads/${file}`;
  }

  // ---------------------------------------------------------------- data

  app.get('/api/export', (_req, res) => {
    res.attachment(`factory-export-${new Date().toISOString().slice(0, 10)}.json`).json(exportFactory());
  });

  app.post('/api/import', asyncRoute(async (req, res) => {
    res.json(await importFactory(req.body, {
      saveImage,
      createProject: async (name, patch) => {
        await validateProject(name, patch, null);
        const project = createProject(name, patch);
        factory.coordinator(project.id);
        void refreshRemote(project.id);
      },
      projectChanged: (id) => factory.coordinator(id).settingsChanged(),
    }));
  }));

  app.get('/api/backups', (_req, res) => {
    res.json({ dir: db.backupsDir(), keyFile: path.join(DATA_DIR, KEY_FILE), backups: db.listBackups() });
  });

  app.post('/api/backups', (_req, res) => {
    res.status(201).json(db.backupDb('manual'));
  });

  // ---------------------------------------------------------------- projects

  app.post('/api/projects', asyncRoute(async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const patch = pickSettings(req.body?.settings ?? {});
    patch.repoPath ??= '';
    await validateProject(name, patch, null);
    const project = createProject(name, patch);
    factory.coordinator(project.id);
    res.status(201).json((await refreshRemote(project.id)) ?? project);
  }));

  app.patch('/api/projects/:pid', asyncRoute(async (req, res) => {
    const project = mustGetProject(req.params.pid);
    const name = req.body?.name === undefined ? project.name : String(req.body.name).trim();
    const patch = pickSettings(req.body?.settings ?? {});
    await validateProject(name, patch, project.id);
    const next = updateProject(project.id, { name, settings: patch });
    factory.coordinator(project.id).settingsChanged();
    res.json((await refreshRemote(project.id)) ?? next);
  }));

  /** Pull and Push buttons: queue (or reuse) an integration card. */
  app.post('/api/projects/:pid/sync/:kind', (req, res) => {
    const project = mustGetProject(req.params.pid);
    const kind = req.params.kind;
    if (kind !== 'pull' && kind !== 'push') throw new HttpError(404, 'Unknown sync');
    res.status(201).json(factory.coordinator(project.id).requestSync(kind));
  });

  /** Tokens and cost in one project, per profile. */
  app.get('/api/projects/:pid/usage', (req, res) => {
    const project = mustGetProject(req.params.pid);
    res.json({ byProfile: db.usageBy('profile_id', project.id), total: db.usageBy('project_id')[project.id] ?? null });
  });

  // ---------------------------------------------------------------- agent profiles and skills

  app.post('/api/profiles', (req, res) => {
    res.status(201).json(saveProfile(req.body ?? {}));
  });

  app.patch('/api/profiles/:id', (req, res) => {
    const existing = db.getProfile(Number(req.params.id));
    if (!existing || existing.archived) throw new HttpError(404, 'Profile not found');
    res.json(saveProfile({ ...existing, ...(req.body ?? {}) }, existing.id));
  });

  app.delete('/api/profiles/:id', (req, res) => {
    removeProfile(Number(req.params.id));
    res.status(204).end();
  });

  app.get('/api/skills/:id', (req, res) => {
    const id = Number(req.params.id);
    const content = skillContent(id);
    res.json({ skill: db.getSkill(id), content, files: skillFiles(id) });
  });

  /** A folder picked in the browser: skill folders grouped client-side, file contents in base64. */
  app.post('/api/skills/import/folder', (req, res) => {
    const { source, skills } = req.body ?? {};
    if (!Array.isArray(skills) || !skills.length) throw new HttpError(400, 'No SKILL.md files in that folder');
    const bundles = skills.map((s: any) => ({
      where: String(s?.where ?? ''),
      files: Array.isArray(s?.files) ? s.files.map((f: any) => ({ path: String(f?.path ?? ''), data: Buffer.from(String(f?.data ?? ''), 'base64') })) : [],
    }));
    res.json(importSkills(bundles, `Folder: ${String(source ?? 'upload').slice(0, 80)}`));
  });

  app.post('/api/skills/import/github', asyncRoute(async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    res.json(await importFromGithub(String(req.body?.url ?? ''), controller.signal));
  }));

  app.post('/api/skills/import/skills-sh', asyncRoute(async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    res.json(await importFromSkillsSh(String(req.body?.ref ?? ''), controller.signal));
  }));

  app.post('/api/skills', (req, res) => {
    if (typeof req.body?.content !== 'string') throw new HttpError(400, 'Upload a SKILL.md');
    res.status(201).json(saveSkill(req.body.content));
  });

  app.delete('/api/skills/:id', (req, res) => {
    deleteSkill(Number(req.params.id));
    res.status(204).end();
  });

  // ---------------------------------------------------------------- folder browser

  /**
   * Folders for choosing a project's path: names only, never file contents.
   * The browser can't reveal a picked folder's real path, so the server lists them.
   */
  app.get('/api/fs/dirs', (req, res) => {
    const requested = String(req.query.path ?? '').trim();
    const dir = path.resolve(requested || os.homedir());
    const hidden = req.query.hidden === '1';
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      throw new HttpError(400, `Can't open ${dir}`);
    }
    const isDir = (e: fs.Dirent) => e.isDirectory() || (e.isSymbolicLink() && (() => {
      try { return fs.statSync(path.join(dir, e.name)).isDirectory(); } catch { return false; }
    })());
    const all = entries
      .filter((e) => (hidden || !e.name.startsWith('.')) && isDir(e))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const dirs = all.slice(0, MAX_FOLDERS).map((e) => ({ name: e.name, path: path.join(dir, e.name), git: fs.existsSync(path.join(dir, e.name, '.git')) }));
    const parent = path.dirname(dir);
    res.json({ path: dir, parent: parent === dir ? null : parent, home: os.homedir(), git: fs.existsSync(path.join(dir, '.git')), dirs, truncated: all.length > dirs.length });
  });

  // ---------------------------------------------------------------- providers

  app.post('/api/providers/refresh', asyncRoute(async (_req, res) => {
    res.json(await refreshProviders());
  }));

  app.patch('/api/providers/:id', (req, res) => {
    const status = providerStatuses().find((s) => s.id === req.params.id);
    if (!status) throw new HttpError(404, 'Unknown provider');
    if (typeof req.body?.enabled !== 'boolean') throw new HttpError(400, 'Say whether to switch it on or off');
    res.json(setProviderEnabled(status.id, req.body.enabled));
  });

  // ---------------------------------------------------------------- assistant

  app.post('/api/assistant/messages', (req, res) => {
    const body = req.body?.body;
    if (typeof body !== 'string') throw new HttpError(400, 'Invalid message');
    assistant.send(body);
    res.status(202).json({ ok: true });
  });


  // ---------------------------------------------------------------- static client

  const dist = path.resolve('dist');
  if (fs.existsSync(dist)) {
    // index.html carries the token, so it's never served from cache or without it.
    const page = (_req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store').type('html').send(withToken(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'), token));
    };
    app.get(['/', '/index.html'], page);
    app.use(express.static(dist, { index: false }));
    app.get(/^(?!\/api\/).*/, page);
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  });

  return app;
}
