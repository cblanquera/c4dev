/** Review handoff and coordinator conversation, available throughout a card's work. */
import { Icon } from './Icon.tsx';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { Markdown } from './Markdown.tsx';
import { MarkdownEditor } from './MarkdownEditor.tsx';
import { AgentName } from './AgentName.tsx';
import { agentLabel } from '../agents.ts';
import type { Card, Comment } from '../../../server/types.ts';

interface Props {
  card: Card;
  cards: Card[];
  comments: Comment[];
  deliveryNotes: string;
  replying: boolean;
  onCardClick: (id: number) => void;
  onError: (message: string) => void;
}

const KIND_LABEL: Record<Comment['kind'], string> = {
  note: '', question: 'asks', input: '', reply: '', approval: 'approved', changes: 'requested changes', handoff: 'prepared a handoff',
};

export function Thread({ card, cards, comments, deliveryNotes, replying, onCardClick, onError }: Props) {
  const [body, setBody] = useState('');
  const [secrets, setSecrets] = useState<{ name: string; value: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const active = card.stage === 'deliverables';
  const conversation = comments.filter((c) => c.kind !== 'handoff');

  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup.
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [comments.length]);

  // Suggest secret fields for names the coordinator asked for.
  useEffect(() => {
    const asked = new Set<string>();
    for (const c of comments) if (c.author === 'coordinator') for (const m of c.body.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)) asked.add(m[1]);
    const missing = [...asked].filter((n) => !card.secretNames.includes(n) && !secrets.some((s) => s.name === n));
    if (active && missing.length) setSecrets((s) => [...s, ...missing.map((name) => ({ name, value: '' }))]);
  }, [comments.length, active]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      setBody('');
      setSecrets([]);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  const secretMap = Object.fromEntries(secrets.filter((s) => s.name.trim() && s.value).map((s) => [s.name.trim(), s.value]));
  const hasInput = !!body.trim() || Object.keys(secretMap).length > 0;

  return (
    <div className="thread">
      <div className="thread-history" role="region" aria-label="Coordinator conversation">
        {deliveryNotes && <section className="delivery-notes" aria-label="Deliverables"><h3>Deliverables</h3><Markdown source={deliveryNotes} onCardClick={onCardClick} /></section>}
        {!conversation.length && <p className="muted small">No conversation yet.</p>}
        {conversation.map((c) => (
          <div key={c.id} className={`bubble from-${c.author} k-${c.kind}`}>
            <div className="bubble-meta">
              {c.author === 'user' ? <strong>You</strong> : <AgentName actor="coordinator" />} {KIND_LABEL[c.kind]}
              {c.via === 'assistant' && <span className="muted"> via <AgentName actor="assistant" as="span" /></span>}
              <span className="muted"> · {new Date(c.ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span>
            </div>
            <Markdown source={c.body} onCardClick={onCardClick} />
          </div>
        ))}
        {replying && <div className="bubble from-coordinator typing"><Icon name="loader-circle" size={12} className="spinner" /> {agentLabel('coordinator')} is thinking…</div>}
        <div ref={end} />
      </div>

      <div className="composer">
        <MarkdownEditor
          value={body}
          onChange={setBody}
          cards={cards}
          selfId={card.id}
          minRows={3}
          ariaLabel="Message coordinator"
          placeholder={active ? (card.deliverableKind === 'approval' ? 'Ask a question, or describe changes you want…' : 'Answer the question, give guidance, or make a decision…') : 'Ask a question, or describe a follow-up task…'}
          onCardClick={onCardClick}
          onSubmit={() => {
            if (hasInput && !busy && !replying) act(() => api.comment(card.id, body, active ? secretMap : {}));
          }}
        />
        {active && secrets.map((s, i) => (
          <div key={i} className="secret-row">
            <input placeholder="NAME" className="mono" value={s.name} onChange={(e) => setSecrets((all) => all.map((x, j) => (j === i ? { ...x, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') } : x)))} />
            <input placeholder="secret value" type="password" autoComplete="off" value={s.value} onChange={(e) => setSecrets((all) => all.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
            <button className="ghost small" aria-label="Remove secret" onClick={() => setSecrets((all) => all.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
          </div>
        ))}
        {active && <p className="muted small">
          Secrets are stored locally, injected into agents and test runs as environment variables, and never shown again.
          {card.secretNames.length > 0 && <> Provided: {card.secretNames.map((n) => <code key={n}>{n}</code>)}.</>}
        </p>}
        <div className="composer-actions">
          {active && <button className="ghost small" onClick={() => setSecrets((s) => [...s, { name: '', value: '' }])}><Icon name="plus" size={14} /> Secret</button>}
          <span className="spacer" />
          <button className="secondary" disabled={busy || replying || !hasInput} onClick={() => act(() => api.comment(card.id, body, active ? secretMap : {}))} title="The coordinator replies and may ask for clarification (⌘↵)">Send</button>
          {active && (card.deliverableKind === 'approval' ? (
            <>
              <button className="secondary" disabled={busy || !body.trim()} onClick={() => act(() => api.changes(card.id, body))} title="Send back to In Progress with your notes">Request changes</button>
              <button className="primary" disabled={busy} onClick={() => act(() => api.approve(card.id, body))}><Icon name="check" /> Approve</button>
            </>
          ) : (
            <button className="primary" disabled={busy} onClick={() => act(() => api.resume(card.id, body, secretMap))} title="Continue work with what's in the thread (and anything typed above)">Resume <Icon name="arrow-right" /></button>
          ))}
        </div>
      </div>
    </div>
  );
}
