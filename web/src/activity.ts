/** Combine each actor's summaries and detail stream without dropping detail-only output. */
import type { LogEntry } from '../../server/types.ts';

export interface TeamMessage {
  entry: LogEntry;
  details: LogEntry[];
}

export function teamMessages(logs: LogEntry[]): TeamMessage[] {
  const messages: TeamMessage[] = [];
  const streams = new Map<string, { latest?: TeamMessage; pending: LogEntry[] }>();
  const ordered = [...logs].sort((a, b) => a.ts - b.ts || a.id - b.id);
  for (const entry of ordered) {
    if (entry.level !== 'summary' && entry.level !== 'detail') continue;
    const key = `${entry.actor}:${entry.subtaskId ?? 'card'}`;
    const stream = streams.get(key) ?? { pending: [] };
    streams.set(key, stream);
    if (entry.level === 'summary') {
      const message = { entry, details: stream.pending };
      stream.pending = [];
      stream.latest = message;
      messages.push(message);
    } else if (stream.latest) {
      stream.latest.details.push(entry);
    } else {
      stream.pending.push(entry);
    }
  }
  // Errors or command output may have no summary at all. Keep those inspectable.
  for (const stream of streams.values()) {
    for (const entry of stream.pending) messages.push({ entry, details: [entry] });
  }
  return messages.sort((a, b) => a.entry.ts - b.entry.ts || a.entry.id - b.entry.id);
}
