/** The cross-project assistant conversation: replies, updates, relayed messages and clickable card previews. */
import { Icon } from './Icon.tsx';
import { useContext, useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { Markdown } from './Markdown.tsx';
import { MarkdownEditor } from './MarkdownEditor.tsx';
import { AgentName } from './AgentName.tsx';
import { CardChip } from './CardChip.tsx';
import { DirectoryContext, assistantOf, providerLabel, useAgentLabel } from '../agents.ts';
import type { AssistantMessage, AssistantState, Card, Project } from '../../../server/types.ts';
import { STATUS_QUESTION } from '../../../server/types.ts';

interface Props {
  assistant: AssistantState;
  cards: Map<number, Card>;
  cardList: Card[];
  projects: Map<number, Project>;
  onCardClick: (id: number) => void;
  onError: (message: string) => void;
}

const KIND_LABEL: Record<AssistantMessage['kind'], string> = {
  message: '', notification: 'update', relay: 'relayed', action: '', error: '',
};

const QUICK_ASKS = [
  { label: 'Status', text: STATUS_QUESTION },
  { label: 'Needs me', text: 'What needs me?' },
];

export function AssistantChat({ assistant, cards, cardList, projects, onCardClick, onError }: Props) {
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const { messages, busy } = assistant;
  const blocked = sending || busy;
  const agentLabel = useAgentLabel();
  const me = assistantOf(useContext(DirectoryContext).profiles.values());

  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup.
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length, busy]);

  async function send(text: string, clear: boolean) {
    if (!text.trim() || blocked) return;
    setSending(true);
    try {
      await api.ask(text);
      if (clear) setBody('');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="assistant" aria-labelledby="assistant-title">
      <header className="section-bar">
        <h2 id="assistant-title"><AgentName actor="assistant" avatar /></h2>
        {me && <span className={`badge ${me.provider === 'simulated' ? 'd-approval' : 'subtle'}`} title="What the assistant runs on (change in Settings → Assistant)">{providerLabel(me.provider)}</span>}
      </header>
      <div className="assistant-history" role="log" aria-label="Assistant conversation">
        {!messages.length && <p className="muted small">Ask for a status update, draft a card in any project, or answer what a project is waiting on.</p>}
        {messages.map((m) => (
          <div key={m.id} className={`bubble from-${m.author} k-${m.kind}`}>
            <div className="bubble-meta">
              {m.kind === 'notification' && <Icon name="bell" size={12} />}
              {m.author === 'user' ? <strong>You</strong> : <AgentName actor="assistant" />} {KIND_LABEL[m.kind]}
              <span className="muted"> · {new Date(m.ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span>
            </div>
            <Markdown source={m.body} onCardClick={onCardClick} />
            {m.details && (
              <details className="bubble-details">
                <summary>Full instructions</summary>
                <Markdown source={m.details} onCardClick={onCardClick} />
              </details>
            )}
            {m.cardIds.some((id) => cards.has(id)) && (
              <ul className="card-chips" aria-label="Cards">
                {m.cardIds.map((id) => cards.get(id)).filter((c): c is Card => !!c).map((card) => (
                  <li key={card.id}><CardChip card={card} projectName={projects.get(card.projectId)?.name ?? ''} onOpen={() => onCardClick(card.id)} /></li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {busy && <div className="bubble from-assistant typing"><Icon name="loader-circle" size={12} className="spinner" /> {agentLabel('assistant')} is thinking…</div>}
        <div ref={end} />
      </div>

      <div className="composer">
        <MarkdownEditor
          value={body}
          onChange={setBody}
          cards={cardList}
          selfId={null}
          minRows={3}
          ariaLabel="Message assistant"
          placeholder="Ask about your projects, or tell me what to do…"
          onCardClick={onCardClick}
          onSubmit={() => send(body, true)}
        />
        <div className="composer-actions">
          {QUICK_ASKS.map((q) => (
            <button key={q.label} className="ghost small" disabled={blocked} onClick={() => send(q.text, false)} title={q.text}>{q.label}</button>
          ))}
          <span className="spacer" />
          <button className="primary" disabled={blocked || !body.trim()} onClick={() => send(body, true)} title="Send (⌘↵)">Send</button>
        </div>
      </div>
    </section>
  );
}
