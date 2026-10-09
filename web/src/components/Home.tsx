/** The default screen: every project at a glance, beside the assistant. */
import { Icon } from './Icon.tsx';
import { useEffect, useState } from 'react';
import { AssistantChat } from './AssistantChat.tsx';
import { usageLine } from '../format.ts';
import { teamProviders } from '../agents.ts';
import { ACTIVE_STAGES, type AgentProfile, type AssistantState, type Card, type Project, type UsageTotals } from '../../../server/types.ts';

interface Props {
  projects: Project[];
  projectMap: Map<number, Project>;
  cards: Map<number, Card>;
  cardList: Card[];
  assistant: AssistantState;
  usage: Record<number, UsageTotals>;
  profiles: AgentProfile[];
  onNewProject: () => void;
  onCardClick: (id: number) => void;
  onError: (message: string) => void;
}

/** The last two folders of a path, e.g. `…/.factory/demo-repo`. */
function shortPath(full: string): string {
  const parts = full.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : full;
}

function CopyPath({ path, onError }: { path: string; onError: (message: string) => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button className="ghost small copy-path" aria-label={copied ? 'Copied repository path' : 'Copy repository path'} title={copied ? 'Copied' : `Copy ${path}`}
      onClick={() => navigator.clipboard.writeText(path).then(() => setCopied(true), () => onError('Could not copy the path'))}>
      <Icon name={copied ? 'check' : 'copy'} size={12} />
    </button>
  );
}

function ProjectTile({ project, cards, usage, profiles, onError }: { project: Project; cards: Card[]; usage?: UsageTotals; profiles: AgentProfile[]; onError: (message: string) => void }) {
  const runs = teamProviders(project, profiles);
  const cutoff = Date.now() - project.settings.completeRetentionDays * 86_400_000;
  const visible = cards.filter((c) => !c.hidden);
  // Anything can need you, including a blocked merge; the counts are your tasks.
  const needsYou = visible.filter((c) => c.stage === 'deliverables').length;
  const tasks = visible.filter((c) => c.kind === 'task');
  const counts = [
    [tasks.filter((c) => ACTIVE_STAGES.includes(c.stage)).length, 'in flight'],
    [tasks.filter((c) => c.stage === 'backlog').length, 'queued'],
    [tasks.filter((c) => c.stage === 'icebox').length, 'in Icebox'],
    [tasks.filter((c) => c.stage === 'complete' && (c.completedAt ?? 0) >= cutoff).length, 'done recently'],
  ].filter(([n]) => n) as [number, string][];
  return (
    <div className="project-tile">
      <span className="project-tile-head">
        {/* The link covers the whole tile; the copy button sits above it. */}
        <h3><a className="project-tile-link" href={`#project-${project.id}`} aria-label={`${project.name} board`}>{project.name}</a></h3>
        {project.settings.paused && <span className="badge subtle">Paused</span>}
        <span className={`badge ${runs.simulated ? 'd-approval' : 'subtle'}`} title="What this project's agents run on">{runs.label}</span>
      </span>
      <span className="project-tile-repo">
        <span className="mono muted small" title={project.settings.repoPath}>{shortPath(project.settings.repoPath)}</span>
        <CopyPath path={project.settings.repoPath} onError={onError} />
      </span>
      <span className="project-tile-counts small">
        {needsYou > 0 && <span className="badge d-input">{needsYou} need{needsYou === 1 ? 's' : ''} you</span>}
        <span className="muted">{counts.map(([n, label]) => `${n} ${label}`).join(' · ') || 'No cards yet'}</span>
      </span>
      {usage && <span className="muted small">{usageLine(usage)}</span>}
    </div>
  );
}

export function Home({ projects, projectMap, cards, cardList, assistant, usage, profiles, onNewProject, onCardClick, onError }: Props) {
  return (
    <main className="home">
      <section className="projects" aria-labelledby="projects-title">
        <header className="section-bar">
          <h2 id="projects-title">Projects</h2>
          <span className="spacer" />
          <button className="secondary small" onClick={onNewProject}><Icon name="plus" size={14} /> New project</button>
        </header>
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.id}><ProjectTile project={project} cards={cardList.filter((c) => c.projectId === project.id)} usage={usage[project.id]} profiles={profiles} onError={onError} /></li>
          ))}
        </ul>
      </section>
      <AssistantChat assistant={assistant} cards={cards} cardList={cardList} projects={projectMap} onCardClick={onCardClick} onError={onError} />
    </main>
  );
}
