/** Live factory state for every project and the assistant, kept in sync with the server over SSE. */
import { useEffect, useMemo, useReducer, useRef } from 'react';
import { api } from './api.ts';
import type { AssistantState, Card, CardDetail, FactoryEvent, FactoryState, Project, Settings } from '../../server/types.ts';

export interface FeedItem {
  projectId: number;
  text: string;
  ts: number;
}

interface State {
  cards: Map<number, Card>;
  projects: Map<number, Project>;
  projectDefaults: Settings | null;
  assistant: AssistantState | null;
  feed: FeedItem[];
  detail: CardDetail | null;
  connected: boolean;
}

type Action =
  | { type: 'loaded'; state: FactoryState }
  | { type: 'event'; event: FactoryEvent }
  | { type: 'detail'; detail: CardDetail | null }
  | { type: 'connected'; value: boolean };

const MAX_MESSAGES = 300;

function upsert<T extends { id: number }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'loaded':
      return {
        ...state,
        cards: new Map(action.state.cards.map((c) => [c.id, c])),
        projects: new Map(action.state.projects.map((p) => [p.id, p])),
        projectDefaults: action.state.projectDefaults,
        assistant: action.state.assistant,
      };
    case 'connected':
      return { ...state, connected: action.value };
    case 'detail':
      return { ...state, detail: action.detail };
    case 'event': {
      const e = action.event;
      const d = state.detail;
      const a = state.assistant;
      switch (e.type) {
        case 'card': {
          const cards = new Map(state.cards);
          cards.set(e.card.id, e.card);
          return { ...state, cards, detail: d && d.card.id === e.card.id ? { ...d, card: e.card } : d };
        }
        case 'card_removed': {
          const cards = new Map(state.cards);
          cards.delete(e.id);
          return { ...state, cards };
        }
        case 'project': {
          const projects = new Map(state.projects);
          projects.set(e.project.id, e.project);
          return { ...state, projects };
        }
        case 'coordinator':
          return { ...state, feed: [{ projectId: e.projectId, text: e.text, ts: e.ts }, ...state.feed].slice(0, 50) };
        case 'assistant_message':
          return a ? { ...state, assistant: { ...a, messages: upsert(a.messages, e.message).slice(-MAX_MESSAGES) } } : state;
        case 'assistant_busy':
          return a ? { ...state, assistant: { ...a, busy: e.busy } } : state;
        case 'assistant_settings':
          return a ? { ...state, assistant: { ...a, settings: e.settings } } : state;
        case 'subtask':
          return d && d.card.id === e.subtask.cardId ? { ...state, detail: { ...d, subtasks: upsert(d.subtasks, e.subtask).sort((a, b) => a.seq - b.seq) } } : state;
        case 'log':
          return d && d.card.id === e.log.cardId ? { ...state, detail: { ...d, logs: upsert(d.logs, e.log) } } : state;
        case 'comment':
          return d && d.card.id === e.comment.cardId ? { ...state, detail: { ...d, comments: upsert(d.comments, e.comment), ...(e.comment.kind === 'handoff' ? { deliveryNotes: e.comment.body } : {}) } } : state;
        case 'chat':
          return d && d.card.id === e.cardId ? { ...state, detail: { ...d, chatBusy: e.busy } } : state;
      }
    }
  }
  return state;
}

export function useFactory(openCardId: number | null) {
  const [state, dispatch] = useReducer(reducer, {
    cards: new Map(), projects: new Map(), projectDefaults: null, assistant: null, feed: [], detail: null, connected: false,
  });
  const openRef = useRef(openCardId);
  openRef.current = openCardId;

  useEffect(() => {
    let source: EventSource | null = null;
    let cancelled = false;
    const connect = () => {
      source = new EventSource('/api/events');
      source.onopen = async () => {
        dispatch({ type: 'connected', value: true });
        // Resync on (re)connect so nothing missed while offline lingers.
        const s = await api.state();
        if (!cancelled) dispatch({ type: 'loaded', state: s });
        if (openRef.current != null) api.card(openRef.current).then((detail) => dispatch({ type: 'detail', detail })).catch(() => {});
      };
      source.onmessage = (m) => dispatch({ type: 'event', event: JSON.parse(m.data) });
      source.onerror = () => dispatch({ type: 'connected', value: false });
    };
    connect();
    return () => {
      cancelled = true;
      source?.close();
    };
  }, []);

  useEffect(() => {
    dispatch({ type: 'detail', detail: null });
    if (openCardId == null) return;
    let live = true;
    api.card(openCardId).then((detail) => live && dispatch({ type: 'detail', detail })).catch(() => {});
    return () => {
      live = false;
    };
  }, [openCardId]);

  const cardList = useMemo(() => [...state.cards.values()], [state.cards]);
  const projectList = useMemo(() => [...state.projects.values()].sort((a, b) => a.id - b.id), [state.projects]);
  return { ...state, cardList, projectList };
}
