import { Icon } from './components/Icon.tsx';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { useFactory } from './store.ts';
import { Board } from './components/Board.tsx';
import { Home } from './components/Home.tsx';
import { CardEditor } from './components/CardEditor.tsx';
import { CardPanel } from './components/CardPanel.tsx';
import { SettingsDialog } from './components/SettingsDialog.tsx';
import { SettingsPage, type SettingsSection } from './components/SettingsPage.tsx';
import { ProcessPopover } from './components/ProcessPopover.tsx';
import { DirectoryContext, ProjectScope, teamProviders } from './agents.ts';
import { go, goHome } from './nav.ts';
import { ACTIVE_STAGES, STAGE_LABELS } from '../../server/types.ts';
import { FactoryLogo, ProjectLogo } from './components/ProjectLogo.tsx';

/**
 * Routing lives in the URL hash. No hash is home: projects beside the
 * assistant. #project-2 is a board and #project-2/new adds a card to it.
 * #card-12 and #new-after-12 open a panel on that card's board, while
 * #chat/card-12 opens the panel over the assistant instead. #settings and
 * #settings/agents open the settings page at a section (#settings/assistant,
 * from before the assistant joined the agents, opens Agents).
 */
type Panel = { kind: 'none' } | { kind: 'card'; id: number } | { kind: 'new'; parentId: number | null };
type Route =
  | { view: 'home'; panel: Panel }
  | { view: 'settings'; section: SettingsSection; panel: Panel }
  | { view: 'board'; projectId: number | null; panel: Panel };

const NO_PANEL: Panel = { kind: 'none' };

function parseHash(hash: string): Route {
  let m = hash.match(/^#card-(\d+)$/);
  if (m) return { view: 'board', projectId: null, panel: { kind: 'card', id: Number(m[1]) } };
  m = hash.match(/^#chat\/card-(\d+)$/);
  if (m) return { view: 'home', panel: { kind: 'card', id: Number(m[1]) } };
  m = hash.match(/^#new-after-(\d+)$/);
  if (m) return { view: 'board', projectId: null, panel: { kind: 'new', parentId: Number(m[1]) } };
  m = hash.match(/^#project-(\d+)(\/new)?$/);
  if (m) return { view: 'board', projectId: Number(m[1]), panel: m[2] ? { kind: 'new', parentId: null } : NO_PANEL };
  m = hash.match(/^#settings(?:\/(assistant|agents|skills|contexts|providers|usage|limits|data))?$/);
  if (m) return { view: 'settings', section: (!m[1] || m[1] === 'assistant' ? 'agents' : m[1]) as SettingsSection, panel: NO_PANEL };
  return { view: 'home', panel: NO_PANEL };
}


/** Id of the newest assistant message read on the home screen, per browser. */
const SEEN_KEY = 'factory.assistantSeen';


export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const [dialog, setDialog] = useState<'project' | 'new-project' | null>(null);
  const [wide, setWide] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [seen, setSeen] = useState(() => Number(localStorage.getItem(SEEN_KEY) ?? 0));
  const { panel } = route;
  const openId = panel.kind === 'card' ? panel.id : null;
  const { cardList, cards, projects, projectList, profiles, profileList, skills, contexts, usage, usageVersion, limits, jev, providers, projectDefaults, assistant, feed, detail, connected } = useFactory(openId);
  const [syncing, setSyncing] = useState(false);

  // A card knows its project, so #card-12 links work from any board or the assistant.
  const anchorId = panel.kind === 'card' ? panel.id : panel.kind === 'new' ? panel.parentId : null;
  const projectId = (route.view === 'board' ? route.projectId : null) ?? (anchorId != null ? cards.get(anchorId)?.projectId ?? null : null);
  const project = projectId != null ? projects.get(projectId) : undefined;
  const projectCards = cardList.filter((c) => c.projectId === projectId);

  const closePanel = useCallback(() => {
    if (route.view === 'home' || projectId == null) goHome();
    else go(`#project-${projectId}`);
  }, [route.view, projectId]);

  useEffect(() => {
    const onHash = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !dialog && panel.kind !== 'none' && !(e.target instanceof HTMLTextAreaElement)) closePanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, dialog, closePanel]);

  // Messages are read on the home screen; boards show a dot until then.
  const latest = assistant?.messages.at(-1)?.id ?? 0;
  useEffect(() => {
    if (route.view !== 'home' || latest <= seen) return;
    localStorage.setItem(SEEN_KEY, String(latest));
    setSeen(latest);
  }, [route.view, latest, seen]);
  const unseen = !!assistant?.messages.some((m) => m.author === 'assistant' && m.id > seen);

  const onError = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast((t) => (t === message ? null : t)), 6000);
  }, []);

  if (!assistant || !projectDefaults) {
    return <div className="loading"><Icon name="loader-circle" size={12} className="spinner" /> Connecting to the factory…</div>;
  }

  const openCard = (id: number) => go(route.view === 'home' ? `#chat/card-${id}` : `#card-${id}`);
  const current = openId != null ? cards.get(openId) : undefined;
  const panelOpen = panel.kind !== 'none' && (route.view === 'board' ? !!project : true);
  const deliverables = projectCards.filter((c) => c.stage === 'deliverables' && !c.hidden).length;
  const working = projectCards.filter((c) => ACTIVE_STAGES.includes(c.stage)).length;
  const missingBoard = route.view === 'board' && !project;

  /** Pull and Push buttons queue an integration card and open it. */
  async function sync(kind: 'pull' | 'push') {
    if (!project) return;
    setSyncing(true);
    try {
      const card = await api.sync(project.id, kind);
      go(`#card-${card.id}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <DirectoryContext.Provider value={{ profiles, projects }}>
    <div className={`app ${panelOpen ? 'panel-open' : ''} ${wide ? 'panel-wide' : ''}`}>
      {route.view === 'home' || route.view === 'settings' || missingBoard ? (
        <header className="topbar">
          {route.view === 'settings'
            ? <a className="brand home-link" href="#" onClick={(e) => { e.preventDefault(); goHome(); }} aria-label="All projects" title="All projects"><FactoryLogo /></a>
            : <div className="brand"><FactoryLogo /></div>}
          {route.view === 'settings' && <h1 className="topbar-title">Settings</h1>}
          <span className={`conn ${connected ? 'on' : 'off'}`} title={connected ? 'Live' : 'Reconnecting…'} />
          <div className="top-actions">
            <ProcessPopover onError={onError} />
            {route.view !== 'settings' && <button className="ghost" onClick={() => go('#settings')} aria-label="Settings" title="Settings: assistant, agents and skills"><Icon name="settings" /></button>}
          </div>
        </header>
      ) : project && (
        <header className="topbar">
          <a className="ghost home-link back-link" href="#" onClick={(e) => { e.preventDefault(); goHome(); }} aria-label={unseen ? 'All projects (new assistant messages)' : 'All projects'} title="All projects">
            <Icon name="arrow-left" />
            {unseen && <span className="dot-unread" />}
          </a>
          <span className="brand"><ProjectLogo url={project.settings.logoUrl} name={project.name} /></span>
          <h1 className="topbar-title">{project.name}</h1>
          <div className="coord">
            <span className={`conn ${connected ? 'on' : 'off'}`} title={connected ? 'Live' : 'Reconnecting…'} />
            <button
              className={`toggle ${project.settings.paused ? '' : 'on'}`}
              role="switch"
              aria-checked={!project.settings.paused}
              aria-label="Coordinator running"
              onClick={() => api.updateProject(project.id, { settings: { paused: !project.settings.paused } }).catch((e) => onError(e.message))}
              title={project.settings.paused ? 'Coordinator paused: nothing new will start' : 'Coordinator running'}
            >
              <span className="knob" />
            </button>
            <span className="coord-label hide-sm">{project.settings.paused ? 'Paused' : 'Coordinator'}</span>
            {(() => {
              const runs = teamProviders(project, profileList);
              return <span className={`badge hide-sm ${runs.simulated ? 'd-approval' : 'subtle'}`} title="What this project's agents run on (each agent's provider)">{runs.label}</span>;
            })()}
            <span className="muted small hide-sm">{working} in flight{deliverables ? ' · ' : ''}</span>
            {deliverables > 0 && <span className="badge d-input hide-sm">{deliverables} need{deliverables === 1 ? 's' : ''} you</span>}
          </div>
          <div className="feed hide-sm" aria-live="polite">{feed.find((f) => f.projectId === project.id)?.text}</div>
          <div className="top-actions">
            {project.remoteUrl && <>
              <button className="ghost" disabled={syncing} onClick={() => sync('pull')} aria-label="Pull" title={`Pull ${project.settings.remote}/${project.settings.baseBranch} into ${project.settings.baseBranch}`}><Icon name="arrow-down-to-line" /><span className="hide-sm">Pull</span></button>
              <button className="ghost" disabled={syncing} onClick={() => sync('push')} aria-label="Push" title={`Push ${project.settings.baseBranch} to ${project.settings.remote}`}><Icon name="arrow-up-from-line" /><span className="hide-sm">Push</span></button>
            </>}
            <ProcessPopover onError={onError} />
            <button className="ghost" onClick={() => setDialog('project')} aria-label="Settings" title="Settings"><Icon name="settings" /></button>
            <button className="primary" onClick={() => go(`#project-${project.id}/new`)} aria-label="New card"><Icon name="plus" /><span className="hide-sm"> New card</span></button>
          </div>
        </header>
      )}

      {route.view === 'home' && (
        <Home projects={projectList} projectMap={projects} cards={cards} cardList={cardList} assistant={assistant} usage={usage.byProject} profiles={profileList}
          onNewProject={() => setDialog('new-project')} onCardClick={openCard} onError={onError} />
      )}
      {route.view === 'settings' && (
        <SettingsPage section={route.section} profiles={profileList} skills={skills} contexts={contexts} projects={projectList} usage={usage.byProfile} monthUsage={usage.month.byProfile}
          limits={limits} providers={providers} jev={jev} usageVersion={usageVersion} onError={onError} />
      )}
      {route.view === 'board' && project && (
        <Board key={project.id} projectId={project.id} cards={projectCards} settings={project.settings} selectedId={openId} onOpen={openCard} onNew={() => go(`#project-${project.id}/new`)} onError={onError} />
      )}
      {missingBoard && (
        <main className="pad">
          <p className="muted">{anchorId != null ? `Card #${anchorId} doesn’t exist.` : 'This project doesn’t exist.'}</p>
          <button className="link" onClick={goHome}>All projects</button>
        </main>
      )}

      {panelOpen && (
        <aside className="panel" aria-label="Card details">
          <header className="panel-head">
            {panel.kind === 'new' ? (
              <h2>{panel.parentId ? `Follow-up to #${panel.parentId}` : 'New card'}</h2>
            ) : current ? (
              <>
                <span className={`stage-pill s-${current.stage}`}>{STAGE_LABELS[current.stage]}</span>
                <h2><span className="mono muted">#{current.id}</span> {current.title}</h2>
              </>
            ) : (
              <h2>Card #{openId}</h2>
            )}
            <span className="spacer" />
            {route.view === 'home' && current && (
              <button className="ghost" onClick={() => go(`#card-${current.id}`)} aria-label="Open board" title={`Open the ${projects.get(current.projectId)?.name} board`}><Icon name="kanban" /></button>
            )}
            <button className="ghost hide-sm" onClick={() => setWide((w) => !w)} title={wide ? 'Narrow panel' : 'Widen panel'} aria-label="Toggle panel width"><Icon name={wide ? 'minimize-2' : 'maximize-2'} /></button>
            <button className="ghost" onClick={closePanel} aria-label="Close panel"><Icon name="x" /></button>
          </header>
          <ProjectScope.Provider value={current?.projectId ?? projectId}>
          <div className="panel-body">
            {panel.kind === 'new' && projectId != null && (
              <CardEditor key={`new-${projectId}-${panel.parentId}`} card={null} projectId={projectId} parentId={panel.parentId} cards={projectCards} onSaved={(c) => openCard(c.id)} onDeleted={closePanel} onCardClick={openCard} onError={onError} />
            )}
            {current?.stage === 'icebox' && (
              <CardEditor key={`edit-${current.id}-${current.stageChangedAt}`} card={current} projectId={current.projectId} parentId={current.parentId} cards={cardList.filter((c) => c.projectId === current.projectId)} onSaved={() => {}} onDeleted={closePanel} onCardClick={openCard} onError={onError} />
            )}
            {current && current.stage !== 'icebox' && detail?.card.id === current.id && (
              <CardPanel cards={cardList.filter((c) => c.projectId === current.projectId)} detail={detail} baseBranch={projects.get(current.projectId)?.settings.baseBranch ?? 'main'} onCardClick={openCard} onFollowUp={(id) => go(`#new-after-${id}`)} onError={onError} />
            )}
            {panel.kind === 'card' && !current && <p className="muted pad">This card doesn’t exist.</p>}
          </div>
          </ProjectScope.Provider>
        </aside>
      )}

      {dialog === 'project' && project && (
        <SettingsDialog project={project} defaults={projectDefaults} profiles={profileList} monthUsage={usage.month.byProject[project.id]} usageVersion={usageVersion} onClose={() => setDialog(null)} onSaved={() => setDialog(null)} onError={onError} />
      )}
      {dialog === 'new-project' && (
        <SettingsDialog project={null} defaults={projectDefaults} profiles={profileList} onClose={() => setDialog(null)} onSaved={(p) => { setDialog(null); go(`#project-${p.id}`); }} onError={onError} />
      )}
      {toast && <div className="toast" role="alert" onClick={() => setToast(null)}>{toast}</div>}
    </div>
    </DirectoryContext.Provider>
  );
}
