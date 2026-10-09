/** Thin typed client for the factory API. */
import type { Card, CardDetail, ProjectProcess, Settings, Stage } from '../../server/types.ts';

async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
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
  state: () => request<{ cards: Card[]; settings: Settings }>('GET', '/api/state'),
  card: (id: number) => request<CardDetail>('GET', `/api/cards/${id}`),
  create: (body: { description: string; instructions: string; instructionsHash: string | null; parentId?: number | null }) =>
    request<Card>('POST', '/api/cards', body),
  update: (id: number, body: { description?: string; instructions?: string; instructionsHash?: string | null }) =>
    request<Card>('PATCH', `/api/cards/${id}`, body),
  remove: (id: number) => request<void>('DELETE', `/api/cards/${id}`),
  move: (id: number, stage: Stage, beforeId: number | null, afterId: number | null) =>
    request<Card>('POST', `/api/cards/${id}/move`, { stage, beforeId, afterId }),
  abort: (id: number) => request<Card>('POST', `/api/cards/${id}/abort`),
  hide: (id: number, hidden: boolean) => request<Card>('POST', `/api/cards/${id}/hide`, { hidden }),
  comment: (id: number, body: string, secrets: Record<string, string>) =>
    request<void>('POST', `/api/cards/${id}/comment`, { body, secrets }),
  approve: (id: number, note: string) => request<Card>('POST', `/api/cards/${id}/approve`, { note }),
  changes: (id: number, body: string) => request<Card>('POST', `/api/cards/${id}/changes`, { body }),
  resume: (id: number, body = '', secrets: Record<string, string> = {}) =>
    request<Card>('POST', `/api/cards/${id}/resume`, { body, secrets }),
  settings: (patch: Partial<Settings>) => request<Settings>('PATCH', '/api/settings', patch),

  async upload(file: File): Promise<string> {
    const res = await fetch('/api/uploads', { method: 'POST', headers: { 'content-type': file.type }, body: file });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Upload failed');
    return data.url;
  },

  /** Streams instruction generation; resolves with the final document and its description hash. */
  async generateInstructions(
    description: string,
    cardId: number | null,
    on: { status: (text: string) => void; text: (chunk: string) => void },
    signal: AbortSignal,
  ): Promise<{ instructions: string; hash: string }> {
    const res = await fetch('/api/instructions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description, cardId }),
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
        else if (event.type === 'done') return { instructions: event.instructions, hash: event.hash };
      }
    }
    throw new Error('Generation ended unexpectedly');
  },
};
