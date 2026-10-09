/** Activity as compact logs, named team chat with expandable details, and diffs. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AgentName } from './AgentName.tsx';
import { DiffView } from './DiffView.tsx';
import { Markdown } from './Markdown.tsx';
import { JOB_CONTEXT, useAgent, useAgentLabel } from '../agents.ts';
import { AGENT_JOBS, JOB_LABELS } from '../../../server/types.ts';
import { teamMessages } from '../activity.ts';
import type { LogEntry, LogLevel, Subtask } from '../../../server/types.ts';

type View = 'oneliner' | 'summary' | 'diff';
const VIEWS: { level: View; label: string }[] = [
  { level: 'summary', label: 'Team Chat' },
  { level: 'oneliner', label: 'Logs' },
  { level: 'diff', label: 'Diffs' },
];
const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function LogView({ logs, subtasks = [], initial = 'summary', showActors = true }: { logs: LogEntry[]; subtasks?: Subtask[]; initial?: LogLevel; showActors?: boolean }) {
  const [level, setLevel] = useState<View>(initial === 'detail' ? 'summary' : initial);
  const [actor, setActor] = useState<string>('all');
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const actors = useMemo(() => [...new Set(logs.map((l) => l.actor))], [logs]);
  const messages = useMemo(() => teamMessages(logs), [logs]);
  const shown = logs.filter((l) => l.level === level && (actor === 'all' || l.actor === actor));
  const assignedTask = (actorId: string, subtaskId?: number | null) => subtasks.find((s) => subtaskId != null ? s.id === subtaskId : s.worker === actorId);
  const agentLabel = useAgentLabel();
  const label = (actorId: string, subtaskId?: number | null, profileId?: number | null) => agentLabel(actorId, { subtask: assignedTask(actorId, subtaskId), profileId });
  const chat = messages.filter((m) => actor === 'all' || m.entry.actor === actor);

  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [logs.length, level, actor]);

  return (
    <div className="logview">
      <div className="logview-bar">
        <div className="seg" role="tablist" aria-label="Activity views">
          {VIEWS.map(({ level: lv, label }) => (
            <button key={lv} role="tab" aria-selected={lv === level} className={lv === level ? 'active' : ''} onClick={() => setLevel(lv)}>
              {label}
            </button>
          ))}
        </div>
        {showActors && actors.length > 1 && (
          <select value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Filter by agent">
            <option value="all">All agents</option>
            {actors.map((a) => <option key={a} value={a}>{label(a)}</option>)}
          </select>
        )}
      </div>
      {showActors && <details className="agent-profiles">
        <summary>About the agent jobs</summary>
        <p className="muted small">Names identify agent profiles, which you can edit on the Agents page. Job titles describe what each profile does; messages come from the recorded agent activity.</p>
        <dl>{AGENT_JOBS.map((job) => <div key={job}><dt>{JOB_LABELS[job]}</dt><dd>{JOB_CONTEXT[job]}</dd></div>)}</dl>
      </details>}
      <div className={`logview-body lv-${level}`} ref={scroller} onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}>
        {!(level === 'summary' ? chat.length : shown.length) && <p className="muted small pad">Nothing logged yet.</p>}
        {level === 'summary' ? chat.map(({ entry, details }) => (
          <article key={entry.id} className={`team-bubble ${entry.actor === 'coordinator' ? 'team-coordinator' : 'team-agent'}`} aria-label={label(entry.actor, entry.subtaskId, entry.profileId)}>
            <div className="log-meta">
              <AgentName actor={entry.actor} subtask={assignedTask(entry.actor, entry.subtaskId)} profileId={entry.profileId} avatar />
              <span className="log-time">{time(entry.ts)}</span>
            </div>
            <Markdown source={entry.level === 'detail' ? entry.text.split('\n')[0] : entry.text} />
            {details.length > 0 && <details className="team-details">
              <summary>View details ({details.length})</summary>
              <ProfileContext actor={entry.actor} subtask={assignedTask(entry.actor, entry.subtaskId)} profileId={entry.profileId} />
              {details.map((d) => (
                <div key={d.id} className="team-detail">
                  <span className="log-time">{time(d.ts)}</span>
                  <pre className="log-pre">{d.text}</pre>
                </div>
              ))}
            </details>}
          </article>
        )) : shown.map((l) => level === 'oneliner' ? (
          <div key={l.id} className="log-line">
            <span className="log-time">{time(l.ts)}</span>
            {showActors && <AgentName actor={l.actor} subtask={assignedTask(l.actor, l.subtaskId)} profileId={l.profileId} as="span" className="actor" />}
            <span className="log-text">{l.text}</span>
          </div>
        ) : (
          <div key={l.id} className="log-block">
            <div className="log-meta">
              {showActors && <AgentName actor={l.actor} subtask={assignedTask(l.actor, l.subtaskId)} profileId={l.profileId} as="span" className="actor" />}
              <span className="log-time">{time(l.ts)}</span>
            </div>
            <DiffView diff={l.text} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** What the agent behind a message sees and was assigned. */
function ProfileContext({ actor, subtask, profileId }: { actor: string; subtask?: Subtask; profileId: number | null }) {
  return <p className="profile-context muted small">{useAgent(actor, { subtask, profileId }).context}</p>;
}
