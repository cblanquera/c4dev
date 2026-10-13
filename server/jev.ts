/**
 * Jev, TypeSafe's decision model, as an optional helper. It answers typed
 * questions (yes/no, choice, score) about a state with probabilities instead
 * of writing text, so routine decisions can skip a full LLM run. It's never
 * required: `ask` returns null whenever Jev isn't added, is switched off,
 * fails or times out, and every caller then does what it did before.
 * The API key is encrypted like card secrets and never leaves the server.
 */
import * as db from './db.ts';
import { emit } from './events.ts';
import { HttpError } from './errors.ts';
import type { JevStatus } from './types.ts';

const KEY = 'jev.apiKey';
const ENABLED = 'jev.enabled';
const MODEL = 'jev.model';
export const DEFAULT_JEV_MODEL = 'jev-latest';
const TIMEOUT_MS = 10_000;
/**
 * TypeSafe's estimate, from its usage dashboard (October 2026): $0.042 per
 * million input tokens, output free. A typical decision is ~400 tokens, about
 * $0.000017. Update this if TypeSafe's billing page changes.
 */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;
/** Text sent to Jev is trimmed: there's no published limit, and decisions need the gist, not every line. */
export const MAX_STATE_CHARS = 12_000;

const baseUrl = () => (process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai').replace(/\/+$/, '');

export function jevStatus(): JevStatus {
  const stored = db.loadSettings();
  return {
    configured: typeof stored[KEY] === 'string',
    enabled: stored[ENABLED] !== false,
    model: typeof stored[MODEL] === 'string' && stored[MODEL] ? String(stored[MODEL]) : DEFAULT_JEV_MODEL,
  };
}

function publish(): JevStatus {
  const jev = jevStatus();
  emit({ type: 'jev', jev });
  return jev;
}

async function call(path: string, apiKey: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return fetch(`${baseUrl()}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
}

/** Adds or updates Jev. A new key is checked first with TypeSafe's model list, which costs nothing. */
export async function saveJev(input: { apiKey?: unknown; model?: unknown; enabled?: unknown }): Promise<JevStatus> {
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!apiKey && !jevStatus().configured) throw new HttpError(400, 'Enter your TypeSafe API key');
  if (apiKey) {
    let res: Response;
    try {
      res = await call('/v1/models', apiKey);
    } catch (err) {
      throw new HttpError(502, `Couldn't reach TypeSafe: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 401 || res.status === 403) throw new HttpError(400, 'TypeSafe refused that API key');
    if (!res.ok) throw new HttpError(502, `TypeSafe answered HTTP ${res.status}; try again`);
    db.setSecretSetting(KEY, apiKey);
  }
  if (input.model !== undefined) {
    const model = String(input.model).trim();
    if (model && !/^[\w.:-]{1,80}$/.test(model)) throw new HttpError(400, 'That isn\'t a valid model name');
    if (model && model !== DEFAULT_JEV_MODEL) db.saveSettings({ [MODEL]: model });
    else db.deleteSettings(MODEL);
  }
  if (typeof input.enabled === 'boolean') db.saveSettings({ [ENABLED]: input.enabled });
  else if (apiKey) db.saveSettings({ [ENABLED]: true });
  return publish();
}

export function removeJev(): JevStatus {
  db.setSecretSetting(KEY, null);
  db.deleteSettings(ENABLED, MODEL);
  return publish();
}

// ------------------------------------------------------------ questions

export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };

export const noul = (instructions: string, criteria?: { true?: string; false?: string }): JevQuestion => ({ type: 'noul', instructions, ...(criteria ? { criteria } : {}) });
export const choice = (instructions: string, criteria: Record<string, string | null>): JevQuestion => ({ type: 'choice', instructions, criteria });
export const score = (instructions: string, criteria: string[]): JevQuestion => ({ type: 'score', instructions, criteria });

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number };

/** Where a decision's tokens are charged; Jev runs aren't done by an agent. */
export interface JevCharge {
  projectId: number | null;
  cardId: number | null;
}

/** Text trimmed for Jev's state. */
export const clip = (text: string, max = MAX_STATE_CHARS) => (text.length > max ? `${text.slice(0, max)}\n[… trimmed]` : text);

/**
 * Asks Jev, or returns null so the caller falls back to its LLM path: Jev not
 * added, switched off, unreachable, slow, or answering something unexpected.
 */
export async function ask(state: Record<string, unknown> | string, questions: Record<string, JevQuestion>, charge: JevCharge, signal?: AbortSignal): Promise<Record<string, JevAnswer> | null> {
  const status = jevStatus();
  if (!status.configured || !status.enabled) return null;
  const apiKey = db.getSecretSetting(KEY);
  if (!apiKey) return null;
  try {
    const res = await call('/v1/systemone', apiKey, { model: status.model, state, questions }, signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json() as { model?: string; answers?: Record<string, JevAnswer>; usage?: { input_tokens?: number; output_tokens?: number } };
    if (!body.answers || Object.keys(questions).some((name) => body.answers![name]?.type !== questions[name].type)) throw new Error('unexpected answer shape');
    const inputTokens = Number(body.usage?.input_tokens) || 0;
    db.addUsage({
      projectId: charge.projectId, cardId: charge.cardId, profileId: null, model: body.model || status.model,
      inputTokens, outputTokens: Number(body.usage?.output_tokens) || 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      costUsd: inputTokens * JEV_USD_PER_INPUT_TOKEN,
    });
    return body.answers;
  } catch (err) {
    if (signal?.aborted) return null;
    console.warn(`Jev unavailable, falling back to the LLM: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
