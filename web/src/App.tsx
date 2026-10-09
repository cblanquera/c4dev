import { Icon } from './components/Icon.tsx';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { useFactory } from './store.ts';
import { Board } from './components/Board.tsx';
import { Home } from './components/Home.tsx';
import { CardEditor } from './components/CardEditor.tsx';
import { CardPanel } from './components/CardPanel.tsx';
import { AssistantSettingsDialog, SettingsDialog } from './components/SettingsDialog.tsx';
import { ProcessPopover } from './components/ProcessPopover.tsx';
import { ACTIVE_STAGES, STAGE_LABELS } from '../../server/types.ts';

/**
 * Routing lives in the URL hash. No hash is home: projects beside the
 * assistant. #project-2 is a board and #project-2/new adds a card to it.
 * #card-12 and #new-after-12 open a panel on that card's board, while
 * #chat/card-12 opens the panel over the assistant instead.
 */
type Panel = { kind: 'none' } | { kind: 'card'; id: number } | { kind: 'new'; parentId: number | null };
type Route = { view: 'home'; panel: Panel } | { view: 'board'; projectId: number | null; panel: Panel };

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
  return { view: 'home', panel: NO_PANEL };
}

const go = (hash: string) => {
  if (location.hash !== hash) location.hash = hash;
};
function goHome() {
  history.pushState(null, '', location.pathname + location.search);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** Id of the newest assistant message read on the home screen, per browser. */
const SEEN_KEY = 'factory.assistantSeen';

const Logo = () => (
  <svg viewBox="0 0 32 32" width="22" height="22" role="img" aria-label="Software Factory"><rect width="32" height="32" rx="7" fill="var(--accent)" /><path d="M8 22V12l5 3v-3l5 3v-3l6 4v6z" fill="white" /></svg>
);

export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const [dialog, setDialog] = useState<'project' | 'new-project' | 'assistant' | null>(null);
  const [wide, setWide] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [seen, setSeen] = useState(() => Number(localStorage.getItem(SEEN_KEY) ?? 0));
  const { panel } = route;
  const openId = panel.kind === 'card' ? panel.id : null;
  const { cardList, cards, projects, projectList, projectDefaults, assistant, feed, detail, connected } = useFactory(openId);

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

  return (
    <div className={`app ${panelOpen ? 'panel-open' : ''} ${wide ? 'panel-wide' : ''}`}>
      {route.view === 'home' || missingBoard ? (
        <header className="topbar">
          <div className="brand"><Logo /></div>
          <span className={`conn ${connected ? 'on' : 'off'}`} title={connected ? 'Live' : 'Reconnecting…'} />
          <div className="top-actions">
            <ProcessPopover onError={onError} />
            <button className="ghost" onClick={() => setDialog('assistant')} aria-label="Assistant settings" title="Assistant settings"><Icon name="settings" /></button>
          </div>
        </header>
      ) : project && (
        <header className="topbar">
          <a className="brand home-link" href="#" onClick={(e) => { e.preventDefault(); goHome(); }} aria-label={unseen ? 'All projects (new assistant messages)' : 'All projects'} title="All projects">
            <Logo />
            {unseen && <span className="dot-unread" />}
          </a>
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
            <span className={`badge hide-sm ${project.settings.driver === 'simulated' ? 'd-approval' : 'subtle'}`} title="Agent driver (change in Settings)">{project.settings.driver === 'simulated' ? 'Simulated' : project.settings.model}</span>
            <span className="muted small hide-sm">{working} in flight{deliverables ? ' · ' : ''}</span>
            {deliverables > 0 && <span className="badge d-input hide-sm">{deliverables} need{deliverables === 1 ? 's' : ''} you</span>}
          </div>
          <div className="feed hide-sm" aria-live="polite">{feed.find((f) => f.projectId === project.id)?.text}</div>
          <div className="top-actions">
            <ProcessPopover onError={onError} />
            <button className="ghost" onClick={() => setDialog('project')} aria-label="Settings" title="Settings"><Icon name="settings" /></button>
            <button className="primary" onClick={() => go(`#project-${project.id}/new`)} aria-label="New card"><Icon name="plus" /><span className="hide-sm"> New card</span></button>
          </div>
        </header>
      )}

      {route.view === 'home' && (
        <Home projects={projectList} projectMap={projects} cards={cards} cardList={cardList} assistant={assistant}
          onNewProject={() => setDialog('new-project')} onCardClick={openCard} onError={onError} />
      )}
      {route.view === 'board' && project && (
        <Board cards={projectCards} settings={project.settings} selectedId={openId} onOpen={openCard} onNew={() => go(`#project-${project.id}/new`)} onError={onError} />
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
        </aside>
      )}

      {dialog === 'project' && project && (
        <SettingsDialog project={project} defaults={projectDefaults} onClose={() => setDialog(null)} onSaved={() => setDialog(null)} onError={onError} />
      )}
      {dialog === 'new-project' && (
        <SettingsDialog project={null} defaults={projectDefaults} onClose={() => setDialog(null)} onSaved={(p) => { setDialog(null); go(`#project-${p.id}`); }} onError={onError} />
      )}
      {dialog === 'assistant' && <AssistantSettingsDialog settings={assistant.settings} onClose={() => setDialog(null)} onError={onError} />}
      {toast && <div className="toast" role="alert" onClick={() => setToast(null)}>{toast}</div>}
    </div>
  );
}
