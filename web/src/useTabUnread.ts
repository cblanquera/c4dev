/** Browser-local read receipts, scoped to a card and the contents of each tab. */
import { useEffect, useState } from 'react';

export type CardTab = 'overview' | 'subtasks' | 'activity' | 'thread';
export type TabContents = Record<CardTab, string>;

const storageKey = (cardId: number) => `factory:tab-read:${cardId}`;

/** Store a compact content fingerprint rather than the card's text. */
export function contentFingerprint(content: unknown): string {
  const text = JSON.stringify(content);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${hash >>> 0}`;
}

function loadRead(cardId: number): Partial<TabContents> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey(cardId)) ?? '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).filter(([key, value]) =>
      ['overview', 'subtasks', 'activity', 'thread'].includes(key) && typeof value === 'string'));
  } catch {
    return {};
  }
}

export function useTabUnread(cardId: number, active: CardTab, contents: TabContents): Record<CardTab, boolean> {
  const [read, setRead] = useState(() => ({ cardId, contents: loadRead(cardId) }));
  const seen = read.cardId === cardId ? read.contents : loadRead(cardId);
  const current = contents[active];

  useEffect(() => {
    setRead((previous) => {
      const saved = previous.cardId === cardId ? previous.contents : loadRead(cardId);
      if (previous.cardId === cardId && saved[active] === current) return previous;
      const next = { ...saved, [active]: current };
      try {
        localStorage.setItem(storageKey(cardId), JSON.stringify(next));
      } catch {
        // Read indicators still work for this panel when browser storage is unavailable.
      }
      return { cardId, contents: next };
    });
  }, [cardId, active, current]);

  return {
    overview: active !== 'overview' && !!contents.overview && seen.overview !== contents.overview,
    subtasks: active !== 'subtasks' && !!contents.subtasks && seen.subtasks !== contents.subtasks,
    activity: active !== 'activity' && !!contents.activity && seen.activity !== contents.activity,
    thread: active !== 'thread' && !!contents.thread && seen.thread !== contents.thread,
  };
}
