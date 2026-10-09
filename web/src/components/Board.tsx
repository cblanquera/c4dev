/** The kanban board. Only Icebox ⇄ Backlog moves (and reordering there) are manual. */
import { Icon } from './Icon.tsx';
import { useMemo, useState, type DragEvent } from 'react';
import { api } from '../api.ts';
import { CardTile } from './CardTile.tsx';
import { STAGES, STAGE_LABELS, type Card, type Settings, type Stage } from '../../../server/types.ts';

const DROP_TARGETS: Partial<Record<Stage, Stage[]>> = {
  icebox: ['icebox', 'backlog'],
  backlog: ['backlog', 'icebox'],
};

interface Props {
  cards: Card[];
  settings: Settings;
  selectedId: number | null;
  onOpen: (id: number) => void;
  onNew: () => void;
  onError: (message: string) => void;
}

export function Board({ cards, settings, selectedId, onOpen, onNew, onError }: Props) {
  const [drag, setDrag] = useState<Card | null>(null);
  const [drop, setDrop] = useState<{ stage: Stage; index: number } | null>(null);
  const [showAllComplete, setShowAllComplete] = useState(false);

  const columns = useMemo(() => {
    const cutoff = Date.now() - settings.completeRetentionDays * 86_400_000;
    const by = Object.fromEntries(STAGES.map((s) => [s, [] as Card[]])) as Record<Stage, Card[]>;
    for (const c of cards) {
      if (c.stage === 'complete') {
        const recent = (c.completedAt ?? 0) >= cutoff && !c.hidden;
        if (!recent && !showAllComplete) continue;
      } else if (c.hidden) continue;
      by[c.stage].push(c);
    }
    for (const s of STAGES) by[s].sort((a, b) => (s === 'complete' ? (b.completedAt ?? 0) - (a.completedAt ?? 0) : a.position - b.position));
    return by;
  }, [cards, settings.completeRetentionDays, showAllComplete]);

  const hiddenComplete = cards.filter((c) => c.stage === 'complete').length - (showAllComplete ? 0 : columns.complete.length);
  const canDrop = (stage: Stage) => !!drag && (DROP_TARGETS[drag.stage] ?? []).includes(stage);

  function overColumn(e: DragEvent, stage: Stage) {
    if (!canDrop(stage)) return;
    e.preventDefault();
    const list = e.currentTarget.querySelectorAll<HTMLElement>('[data-card-id]');
    let index = list.length;
    for (const [i, el] of [...list].entries()) {
      const r = el.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        index = i;
        break;
      }
    }
    if (drop?.stage !== stage || drop.index !== index) setDrop({ stage, index });
  }

  async function onDrop(e: DragEvent, stage: Stage) {
    e.preventDefault();
    const card = drag;
    const target = drop;
    setDrag(null);
    setDrop(null);
    if (!card || !target || !canDrop(stage)) return;
    // Work out neighbours as if the dragged card were already out of the list.
    const rest = columns[stage].filter((c) => c.id !== card.id);
    const index = target.index - (columns[stage].slice(0, target.index).some((c) => c.id === card.id) ? 1 : 0);
    const above = rest[index - 1];
    const below = rest[index];
    if (card.stage === stage && columns[stage].findIndex((c) => c.id === card.id) === index) return;
    try {
      await api.move(card.id, stage, above?.id ?? null, below?.id ?? null);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Move failed');
    }
  }

  return (
    <main className="board" aria-label="Board">
      {STAGES.map((stage) => {
        const list = columns[stage];
        const droppable = canDrop(stage);
        return (
          <section
            key={stage}
            className={`column s-${stage} ${drag ? (droppable ? 'can-drop' : 'no-drop') : ''} ${drop?.stage === stage ? 'over' : ''}`}
            aria-label={STAGE_LABELS[stage]}
            onDragOver={(e) => overColumn(e, stage)}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null);
            }}
            onDrop={(e) => onDrop(e, stage)}
          >
            <header className="column-head">
              <span className="column-dot" />
              <h2>{STAGE_LABELS[stage]}</h2>
              <span className="count">{list.length}</span>
              {stage === 'icebox' && <button className="ghost small add" onClick={onNew} title="New card" aria-label="New card"><Icon name="plus" /></button>}
            </header>
            <div className="column-body">
              {list.map((card, i) => (
                <div key={card.id} data-card-id={card.id}>
                  {drop?.stage === stage && drop.index === i && <div className="drop-line" />}
                  <CardTile
                    card={card}
                    selected={card.id === selectedId}
                    draggable={!!DROP_TARGETS[card.stage]}
                    dragging={drag?.id === card.id}
                    onOpen={() => onOpen(card.id)}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', String(card.id));
                      setDrag(card);
                    }}
                    onDragEnd={() => {
                      setDrag(null);
                      setDrop(null);
                    }}
                  />
                </div>
              ))}
              {drop?.stage === stage && drop.index === list.length && <div className="drop-line" />}
              {!list.length && <div className="empty">{stage === 'icebox' ? <button className="link" onClick={onNew}>Create a card</button> : 'Nothing here'}</div>}
            </div>
            {stage === 'complete' && (hiddenComplete > 0 || showAllComplete) && (
              <button className="link small column-foot" onClick={() => setShowAllComplete((v) => !v)}>
                {showAllComplete ? 'Show recent only' : `Show ${hiddenComplete} hidden or older`}
              </button>
            )}
          </section>
        );
      })}
    </main>
  );
}
