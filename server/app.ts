/** HTTP API + SSE stream. Business rules for manual moves live here. */
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as db from './db.ts';
import { subscribe } from './events.ts';
import { Coordinator, HttpError } from './coordinator.ts';
import { DATA_DIR, settings, updateSettings } from './settings.ts';
import type { Driver } from './agents/driver.ts';
import { STAGES, type CardDetail, type Settings, type Stage } from './types.ts';
import { deliveryNotes } from './delivery.ts';
import { DevmetricsProcesses, type ProcessManager } from './processes.ts';

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

export function createApp(coordinator: Coordinator, driver: () => Driver, processes: ProcessManager = new DevmetricsProcesses(() => [process.cwd(), settings().repoPath, path.join(DATA_DIR, 'worktrees')])) {
  const app = express();
  const uploadsDir = path.join(DATA_DIR, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  app.use(express.json({ limit: '2mb' }));
  app.use('/uploads', express.static(uploadsDir, { maxAge: '1y', immutable: true }));

  app.get('/api/state', (_req, res) => {
    res.json({ cards: db.listCards(), settings: settings() });
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
      deliveryNotes: db.redactSecrets(card.id, deliveryNotes(card, subtasks, logs, comments, settings())),
      chatBusy: coordinator.isChatBusy(card.id),
    };
    res.json(detail);
  });

  app.post('/api/cards', (req, res) => {
    const { description, instructions = '', instructionsHash = null, parentId = null } = req.body ?? {};
    if (typeof description !== 'string' || !description.trim()) throw new HttpError(400, 'Description is required');
    res.status(201).json(db.createCard({
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
    const to = stage as Stage;
    const from = card.stage;
    const allowed = (from === to && (to === 'icebox' || to === 'backlog')) || (from === 'icebox' && to === 'backlog') || (from === 'backlog' && to === 'icebox');
    if (!allowed) throw new HttpError(409, `Cards can't be moved from ${from} to ${to} by hand`);

    if (from === 'icebox' && to === 'backlog') {
      if (!card.instructions.trim()) throw new HttpError(409, 'Generate agent instructions before moving to the Backlog');
      if (card.instructionsHash !== db.hashText(card.description)) {
        throw new HttpError(409, 'The description changed since the instructions were generated. Regenerate them (or mark them current) first.');
      }
    }
    if (from === 'backlog' && to === 'icebox' && coordinator.isBusy(card.id)) {
      await coordinator.abort(card.id);
    }
    const position = db.positionBetween(to, beforeId, afterId);
    const moved = db.moveCard(card.id, to, position)!;
    if (to === 'backlog' && from !== 'backlog') db.setStatus(card.id, 'queued', 'Queued for the coordinator');
    if (to === 'icebox' && from !== 'icebox') db.setStatus(card.id, 'idle', '');
    coordinator.tick();
    res.json(moved);
  }));

  app.post('/api/cards/:id/abort', asyncRoute(async (req, res) => {
    res.json(await coordinator.abort(cardId(req)));
  }));

  app.post('/api/cards/:id/hide', (req, res) => {
    const card = mustGet(cardId(req));
    res.json(db.updateCard(card.id, { hidden: req.body?.hidden !== false }));
  });

  app.post('/api/cards/:id/comment', (req, res) => {
    const { body = '', secrets = {} } = req.body ?? {};
    if (typeof body !== 'string' || !secrets || typeof secrets !== 'object' || Array.isArray(secrets)) throw new HttpError(400, 'Invalid message');
    if (!String(body).trim() && !Object.keys(secrets).length) throw new HttpError(400, 'Say something');
    coordinator.comment(cardId(req), String(body), secrets);
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
    await coordinator.approve(cardId(req), String(req.body?.note ?? ''));
    res.json(db.getCard(cardId(req)));
  }));

  app.post('/api/cards/:id/changes', (req, res) => {
    const body = String(req.body?.body ?? '').trim();
    if (!body) throw new HttpError(400, 'Describe the changes you want');
    coordinator.requestChanges(cardId(req), body);
    res.json(db.getCard(cardId(req)));
  });

  app.post('/api/cards/:id/resume', (req, res) => {
    coordinator.resumeFromDeliverables(cardId(req), String(req.body?.body ?? ''), req.body?.secrets ?? {});
    res.json(db.getCard(cardId(req)));
  });

  // ---------------------------------------------------------------- instructions

  /** Streams NDJSON events: {type:'status'|'text', text} … {type:'done', instructions, hash}. */
  app.post('/api/instructions', asyncRoute(async (req, res) => {
    const description = String(req.body?.description ?? '');
    if (!description.trim()) throw new HttpError(400, 'Write a description first');
    const selfId = Number(req.body?.cardId) || undefined;
    const references = db.parseTags(description, selfId).map((id) => db.getCard(id)).filter((c) => !!c);
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
    const send = (obj: unknown) => res.write(`${JSON.stringify(obj)}\n`);
    try {
      const instructions = await driver().generateInstructions(
        { description, references, repoPath: settings().repoPath },
        (e) => send(e),
        controller.signal,
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

  // ---------------------------------------------------------------- settings

  app.get('/api/settings', (_req, res) => res.json(settings()));

  app.patch('/api/settings', (req, res) => {
    const patch = req.body as Partial<Settings>;
    const allowed = Object.keys(settings());
    const clean = Object.fromEntries(Object.entries(patch ?? {}).filter(([k]) => allowed.includes(k))) as Partial<Settings>;
    if (clean.repoPath) clean.repoPath = path.resolve(clean.repoPath);
    const next = updateSettings(clean);
    coordinator.settingsChanged();
    res.json(next);
  });

  // ---------------------------------------------------------------- static client

  const dist = path.resolve('dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  });

  return app;
}
