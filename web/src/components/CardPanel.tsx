/** Read-only card view for every stage past the Icebox: overview, subtasks, activity and thread. */
import { Icon } from './Icon.tsx';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { Markdown } from './Markdown.tsx';
import { LogView } from './LogView.tsx';
import { DiffView } from './DiffView.tsx';
import { Thread } from './Thread.tsx';
import { AgentName } from './AgentName.tsx';
import { contentFingerprint, useTabUnread } from '../useTabUnread.ts';
import type { CardTab } from '../useTabUnread.ts';
import { isBusy } from './CardTile.tsx';
import { STAGE_LABELS, type Card, type CardDetail, type Stage, type Subtask } from '../../../server/types.ts';

type Tab = CardTab;
const TAB_LABELS: Record<Tab, string> = { overview: 'Overview', subtasks: 'Subtasks', activity: 'Activity', thread: 'Thread' };

const ABORTABLE: Stage[] = ['backlog', 'in_progress', 'verification', 'acceptance', 'deliverables'];

function defaultTab(stage: Stage): Tab {
  if (stage === 'deliverables') return 'thread';
  if (stage === 'in_progress' || stage === 'acceptance') return 'subtasks';
  if (stage === 'verification') return 'activity';
  return 'overview';
}

const duration = (s: Subtask) => {
  if (!s.startedAt) return '';
  const ms = (s.endedAt ?? Date.now()) - s.startedAt;
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
};

function roundLabel(round: number, subtasks: Subtask[]): string {
  const kinds = new Set(subtasks.filter((s) => s.round === round).map((s) => s.kind));
  if (kinds.size === 1 && kinds.has('acceptance')) return 'Acceptance scripts';
  const first = Math.min(...subtasks.map((s) => s.round));
  return round === first ? 'Plan' : `Rework ${round - first}`;
}

interface Props {
  detail: CardDetail;
  cards: Card[];
  onCardClick: (id: number) => void;
  onFollowUp: (id: number) => void;
  onError: (message: string) => void;
}

export function CardPanel({ detail, cards, onCardClick, onFollowUp, onError }: Props) {
  const { card, subtasks, logs, comments } = detail;
  const [tab, setTab] = useState<Tab>(defaultTab(card.stage));
  const [openSubtask, setOpenSubtask] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const contents = useMemo(() => ({
    overview: contentFingerprint([
      card.description, card.instructions, card.branch, card.worktree, card.coverage,
      card.loops, card.parentId, card.createdAt, card.completedAt,
    ]),
    subtasks: subtasks.length ? contentFingerprint(subtasks) : '',
    activity: logs.length ? contentFingerprint(logs) : '',
    thread: comments.length || detail.deliveryNotes ? contentFingerprint([comments, detail.deliveryNotes]) : '',
  }), [card, subtasks, logs, comments, detail.deliveryNotes]);
  const unread = useTabUnread(card.id, tab, contents);

  useEffect(() => {
    setTab(defaultTab(card.stage));
  }, [card.id, card.stage]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  const rounds = [...new Set(subtasks.map((s) => s.round))].sort((a, b) => b - a);
  const done = subtasks.filter((s) => s.status === 'done').length;

  return (
    <div className="card-panel">
      <div className="status-strip">
        {isBusy(card) && <Icon name="loader-circle" size={12} className="spinner" />}
        <span>{card.statusText || STAGE_LABELS[card.stage]}</span>
        <span className="spacer" />
        {subtasks.length > 0 && <span className="muted small">{done}/{subtasks.length} subtasks</span>}
      </div>

      <div className="tabs" role="tablist" aria-label="Card sections">
        {(['overview', 'subtasks', 'activity', 'thread'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-label={TAB_LABELS[t]} aria-selected={tab === t} aria-describedby={unread[t] ? `tab-${card.id}-${t}-unread` : undefined} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {TAB_LABELS[t]}
            {unread[t] && <span id={`tab-${card.id}-${t}-unread`} className="dot-unread" role="status" aria-label="Unread content" />}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="tab-body">
          <dl className="meta">
            {card.branch && <><dt>Branch</dt><dd className="mono">{card.branch}</dd></>}
            {card.worktree && <><dt>Worktree</dt><dd className="mono small">{card.worktree}</dd></>}
            {card.coverage != null && <><dt>Coverage</dt><dd>{card.coverage.toFixed(1)}%</dd></>}
            {card.loops > 0 && <><dt>Loops</dt><dd>{card.loops} round(s) back to In Progress</dd></>}
            {card.parentId && <><dt>Follow-up of</dt><dd><a href={`#card-${card.parentId}`} onClick={(e) => { e.preventDefault(); onCardClick(card.parentId!); }}>#{card.parentId}</a></dd></>}
            <dt>Created</dt><dd>{new Date(card.createdAt).toLocaleString()}</dd>
            {card.completedAt && <><dt>Completed</dt><dd>{new Date(card.completedAt).toLocaleString()}</dd></>}
          </dl>
          <h4>Task</h4>
          <Markdown source={card.description} onCardClick={onCardClick} className="md-box" />
          <details className="instructions-details">
            <summary>Agent instructions</summary>
            <Markdown source={card.instructions} onCardClick={onCardClick} className="md-box" />
          </details>
        </div>
      )}

      {tab === 'subtasks' && (
        <div className="tab-body">
          {!subtasks.length && <p className="muted">{card.stage === 'backlog' ? 'The coordinator will split this into subtasks when it picks the card up.' : 'No subtasks.'}</p>}
          {rounds.map((round) => (
            <div key={round} className="round">
              <h4 className="round-head">{roundLabel(round, subtasks)}<span className="muted small"> · {subtasks.filter((s) => s.round === round).length} subtask(s)</span></h4>
              {subtasks.filter((s) => s.round === round).sort((a, b) => b.seq - a.seq).map((s) => {
                const open = openSubtask === s.id;
                const subLogs = logs.filter((l) => l.subtaskId === s.id);
                const last = [...subLogs].reverse().find((l) => l.level === 'oneliner');
                return (
                  <div key={s.id} className={`subtask st-${s.status} ${open ? 'open' : ''}`}>
                    <button className="subtask-head" onClick={() => setOpenSubtask(open ? null : s.id)} aria-expanded={open}>
                      <span className={`st-icon st-${s.status}`} role="img" aria-label={s.status}>{s.status === 'running' ? <Icon name="loader-circle" className="spinner" /> : <Icon name={s.status === 'done' ? 'circle-check' : s.status === 'failed' ? 'circle-alert' : s.status === 'blocked' ? 'circle-help' : s.status === 'aborted' ? 'circle-x' : 'circle'} />}</span>
                      <span className="subtask-title">
                        <span className="mono muted">{s.seq}</span> {s.title}
                        {s.kind !== 'build' && <span className={`badge k-${s.kind}`}>{s.kind}</span>}
                      </span>
                      <span className="subtask-meta muted small">
                        {s.worker && <AgentName actor={s.worker} subtask={s} as="span" />}
                        {s.files.length > 0 && <span>{s.files.length} file{s.files.length > 1 ? 's' : ''}</span>}
                        <span>{duration(s)}</span>
                      </span>
                    </button>
                    {!open && s.status === 'running' && last && <div className="subtask-latest muted small">{last.text}</div>}
                    {open && (
                      <div className="subtask-body">
                        <details>
                          <summary>Instructions</summary>
                          <Markdown source={`${s.instructions}\n\n**Done when:** ${s.doneWhen || '—'}`} onCardClick={onCardClick} />
                        </details>
                        {s.files.length > 0 && (
                          <ul className="files">
                            {s.files.map((f) => <li key={f.path}><span className="mono">{f.path}</span> <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span></li>)}
                          </ul>
                        )}
                        <LogView logs={subLogs} subtasks={[s]} showActors={false} />
                        {s.diff && subLogs.every((l) => l.level !== 'diff') && <DiffView diff={s.diff} />}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {tab === 'activity' && (
        <div className="tab-body flush">
          <LogView logs={logs} subtasks={subtasks} />
        </div>
      )}

      {tab === 'thread' && (
        <div className="tab-body thread-tab">
          <Thread cards={cards} card={card} comments={comments} deliveryNotes={detail.deliveryNotes} replying={detail.chatBusy} onCardClick={onCardClick} onError={onError} />
        </div>
      )}

      <footer className="panel-actions">
        {ABORTABLE.includes(card.stage) && (
          <button className="danger ghost" disabled={busy} onClick={() => {
            if (confirm(`Abort #${card.id}? Running agents stop, worktrees are removed and branches archived. The card returns to the Icebox.`)) run(() => api.abort(card.id));
          }}><Icon name="square" /> Abort</button>
        )}
        {card.stage === 'backlog' && !isBusy(card) && (
          <button className="secondary" disabled={busy} onClick={() => run(() => api.move(card.id, 'icebox', null, null))}><Icon name="arrow-left" /> Back to Icebox</button>
        )}
        <span className="spacer" />
        {card.stage === 'complete' && (
          <button className="ghost" disabled={busy} onClick={() => run(() => api.hide(card.id, !card.hidden))}>{card.hidden ? 'Unhide' : 'Hide'}</button>
        )}
        {(card.stage === 'complete' || card.stage === 'deliverables') && (
          <button className={card.stage === 'complete' ? 'primary' : 'ghost'} onClick={() => onFollowUp(card.id)}><Icon name="plus" /> Follow-up card</button>
        )}
      </footer>
    </div>
  );
}
