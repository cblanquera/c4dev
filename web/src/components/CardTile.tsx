import { Icon } from './Icon.tsx';
import type { DragEvent } from 'react';
import { CARD_KIND_LABELS, type Card, type CardKind } from '../../../server/types.ts';

/** Integration cards carry the operation's icon so they read differently from your tasks. */
export const KIND_ICON = { merge: 'git-merge', pull: 'arrow-down-to-line', push: 'arrow-up-from-line' } as const satisfies Record<Exclude<CardKind, 'task'>, string>;

export function KindBadge({ card }: { card: Card }) {
  if (card.kind === 'task') return null;
  return <span className={`badge kind-badge kind-${card.kind}`} title="Queued by the factory, not written by you"><Icon name={KIND_ICON[card.kind]} size={12} />{CARD_KIND_LABELS[card.kind]}</span>;
}

const BUSY = new Set(['planning', 'running', 'testing', 'auditing', 'deciding', 'replying', 'merging']);

export function isBusy(card: Card): boolean {
  return BUSY.has(card.status);
}

const DELIVERABLE_LABEL = { approval: 'Approval', input: 'Needs input', blocked: 'Needs help' } as const;

export const MERGE_LABEL = { merged: 'Merged', unmerged: 'Not merged', blocked: 'Merge blocked' } as const;

/** Where a completed card's work went; the note explains why on hover. */
export function MergeBadge({ card }: { card: Card }) {
  // Shown in every stage, so a finished card back on the board explains itself.
  if (card.merging) return <span className="badge subtle" title="A merge into the base branch is in progress">Merging…</span>;
  if (card.stage !== 'complete' || !card.mergeState) return null;
  // A link when merged, a broken link otherwise; the name and the reason stay available to everyone.
  return (
    <span className={`badge icon-only m-${card.mergeState}`} role="img" aria-label={MERGE_LABEL[card.mergeState]} title={`${MERGE_LABEL[card.mergeState]}: ${card.mergeNote}`}>
      <Icon name={card.mergeState === 'merged' ? 'link' : 'unlink'} size={12} />
    </span>
  );
}

interface Props {
  card: Card;
  selected: boolean;
  draggable: boolean;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
}

export function CardTile({ card, selected, draggable, dragging, onOpen, onDragStart, onDragEnd }: Props) {
  const stale = card.stage === 'icebox' && (!card.instructions.trim() ? 'No agent instructions yet' : !card.instructionsCurrent ? 'Instructions are outdated' : '');
  return (
    <article
      className={`card kind-${card.kind} ${selected ? 'selected' : ''} ${dragging ? 'dragging' : ''} ${draggable ? 'draggable' : ''}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      tabIndex={0}
      aria-label={`Card ${card.id}: ${card.title}`}
      data-kind={card.kind}
    >
      <div className="card-top">
        <span className="mono muted">#{card.id}</span>
        <KindBadge card={card} />
        {card.deliverableKind && <span className={`badge d-${card.deliverableKind}`}>{DELIVERABLE_LABEL[card.deliverableKind]}</span>}
        <MergeBadge card={card} />
        <span className="spacer" />
        {card.loops > 0 && <span className="badge subtle" title="Times sent back to In Progress"><Icon name="rotate-ccw" size={12} /> {card.loops}</span>}
        {card.coverage != null && <span className="badge subtle" title="Line coverage">{Math.round(card.coverage)}%</span>}
        {card.secretNames.length > 0 && <span className="badge subtle" title={`Secrets: ${card.secretNames.join(', ')}`} role="img" aria-label={`Secrets: ${card.secretNames.join(', ')}`}><Icon name="key-round" size={12} /></span>}
      </div>
      <h3 className="card-title">{card.title}</h3>
      {(card.statusText || stale) && (
        <div className={`card-status ${stale ? 'warn' : ''}`}>
          {isBusy(card) && <Icon name="loader-circle" size={12} className="spinner" />}
          <span>{stale || card.statusText}</span>
        </div>
      )}
      {(card.tags.length > 0 || card.parentId) && (
        <div className="card-tags">
          {card.parentId && <span className="chip" title="Follow-up of"><Icon name="corner-down-right" size={12} /> #{card.parentId}</span>}
          {card.tags.filter((t) => t !== card.parentId).map((t) => <span key={t} className="chip">#{t}</span>)}
        </div>
      )}
    </article>
  );
}
