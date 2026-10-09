/** A compact, clickable card preview for conversations: number, stage, project and status. */
import { Icon } from './Icon.tsx';
import { KindBadge, MergeBadge, isBusy } from './CardTile.tsx';
import { STAGE_LABELS, type Card } from '../../../server/types.ts';

const WAITING_LABEL = { approval: 'Approval', input: 'Needs input', blocked: 'Needs help' } as const;

export function CardChip({ card, projectName, onOpen }: { card: Card; projectName: string; onOpen: () => void }) {
  return (
    <button className={`card-chip s-${card.stage}`} onClick={onOpen} aria-label={`Open card ${card.id}: ${card.title}`}>
      <span className="card-chip-top">
        <span className="mono muted">#{card.id}</span>
        <span className="stage-pill">{STAGE_LABELS[card.stage]}</span>
        <KindBadge card={card} />
        {card.deliverableKind && <span className={`badge d-${card.deliverableKind}`}>{WAITING_LABEL[card.deliverableKind]}</span>}
        <MergeBadge card={card} />
        <span className="card-chip-project muted">{projectName}</span>
      </span>
      <span className="card-chip-title">{card.title}</span>
      {card.statusText && (
        <span className="card-status">
          {isBusy(card) && <Icon name="loader-circle" size={12} className="spinner" />}
          <span>{card.statusText}</span>
        </span>
      )}
    </button>
  );
}
