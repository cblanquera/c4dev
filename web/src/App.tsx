import { Icon } from './components/Icon.tsx';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { useFactory } from './store.ts';
import { Board } from './components/Board.tsx';
import { CardEditor } from './components/CardEditor.tsx';
import { CardPanel } from './components/CardPanel.tsx';
import { SettingsDialog } from './components/SettingsDialog.tsx';
import { ProcessPopover } from './components/ProcessPopover.tsx';
import { STAGE_LABELS } from '../../server/types.ts';

/** Panel routing lives in the URL hash: #card-12, #new, #new-after-12. */
type Route = { kind: 'none' } | { kind: 'card'; id: number } | { kind: 'new'; parentId: number | null };

function parseHash(hash: string): Route {
  const card = hash.match(/^#card-(\d+)$/);
  if (card) return { kind: 'card', id: Number(card[1]) };
  const fresh = hash.match(/^#new(?:-after-(\d+))?$/);
  if (fresh) return { kind: 'new', parentId: fresh[1] ? Number(fresh[1]) : null };
  return { kind: 'none' };
}

const go = (hash: string) => {
  if (location.hash !== hash) location.hash = hash;
};
function close() {
  history.pushState(null, '', location.pathname + location.search);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const [showSettings, setShowSettings] = useState(false);
  const [wide, setWide] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const openId = route.kind === 'card' ? route.id : null;
  const { cardList, settings, feed, detail, connected, cards } = useFactory(openId);

  useEffect(() => {
    const onHash = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !showSettings && route.kind !== 'none' && !(e.target instanceof HTMLTextAreaElement)) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [route, showSettings]);

  const onError = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast((t) => (t === message ? null : t)), 6000);
  }, []);

  const openCard = (id: number) => go(`#card-${id}`);
  const current = openId != null ? cards.get(openId) : undefined;
  const panelOpen = route.kind === 'new' || route.kind === 'card';
  const deliverables = cardList.filter((c) => c.stage === 'deliverables' && !c.hidden).length;
  const working = cardList.filter((c) => ['in_progress', 'verification', 'acceptance'].includes(c.stage)).length;

  if (!settings) {
    return <div className="loading"><Icon name="loader-circle" size={12} className="spinner" /> Connecting to the factory…</div>;
  }

  return (
    <div className={`app ${panelOpen ? 'panel-open' : ''} ${wide ? 'panel-wide' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <svg viewBox="0 0 32 32" width="22" height="22" role="img" aria-label="Software Factory"><rect width="32" height="32" rx="7" fill="var(--accent)" /><path d="M8 22V12l5 3v-3l5 3v-3l6 4v6z" fill="white" /></svg>
        </div>
        <div className="coord">
          <span className={`conn ${connected ? 'on' : 'off'}`} title={connected ? 'Live' : 'Reconnecting…'} />
          <button
            className={`toggle ${settings.paused ? '' : 'on'}`}
            role="switch"
            aria-checked={!settings.paused}
            onClick={() => api.settings({ paused: !settings.paused }).catch((e) => onError(e.message))}
            title={settings.paused ? 'Coordinator paused: nothing new will start' : 'Coordinator running'}
          >
            <span className="knob" />
          </button>
          <span className="coord-label hide-sm">{settings.paused ? 'Paused' : 'Coordinator'}</span>
          <span className={`badge ${settings.driver === 'simulated' ? 'd-approval' : 'subtle'}`} title="Agent driver (change in Settings)">{settings.driver === 'simulated' ? 'Simulated' : settings.model}</span>
          <span className="muted small hide-sm">{working} in flight{deliverables ? ' · ' : ''}</span>
          {deliverables > 0 && <span className="badge d-input hide-sm">{deliverables} need{deliverables === 1 ? 's' : ''} you</span>}
        </div>
        <div className="feed hide-sm" aria-live="polite">{feed[0]?.text}</div>
        <div className="top-actions">
          <ProcessPopover onError={onError} />
          <button className="ghost" onClick={() => setShowSettings(true)} aria-label="Settings" title="Settings"><Icon name="settings" /></button>
          <button className="primary" onClick={() => go('#new')} aria-label="New card"><Icon name="plus" /><span className="hide-sm"> New card</span></button>
        </div>
      </header>

      <Board cards={cardList} settings={settings} selectedId={openId} onOpen={openCard} onNew={() => go('#new')} onError={onError} />

      {panelOpen && (
        <aside className="panel" aria-label="Card details">
          <header className="panel-head">
            {route.kind === 'new' ? (
              <h2>{route.parentId ? `Follow-up to #${route.parentId}` : 'New card'}</h2>
            ) : current ? (
              <>
                <span className={`stage-pill s-${current.stage}`}>{STAGE_LABELS[current.stage]}</span>
                <h2><span className="mono muted">#{current.id}</span> {current.title}</h2>
              </>
            ) : (
              <h2>Card #{openId}</h2>
            )}
            <span className="spacer" />
            <button className="ghost hide-sm" onClick={() => setWide((w) => !w)} title={wide ? 'Narrow panel' : 'Widen panel'} aria-label="Toggle panel width"><Icon name={wide ? 'minimize-2' : 'maximize-2'} /></button>
            <button className="ghost" onClick={close} aria-label="Close panel"><Icon name="x" /></button>
          </header>
          <div className="panel-body">
            {route.kind === 'new' && (
              <CardEditor key={`new-${route.parentId}`} card={null} parentId={route.parentId} cards={cardList} onSaved={(c) => openCard(c.id)} onDeleted={close} onCardClick={openCard} onError={onError} />
            )}
            {route.kind === 'card' && current?.stage === 'icebox' && (
              <CardEditor key={`edit-${current.id}-${current.stageChangedAt}`} card={current} parentId={current.parentId} cards={cardList} onSaved={() => {}} onDeleted={close} onCardClick={openCard} onError={onError} />
            )}
            {route.kind === 'card' && current && current.stage !== 'icebox' && detail?.card.id === current.id && (
              <CardPanel cards={cardList} detail={detail} onCardClick={openCard} onFollowUp={(id) => go(`#new-after-${id}`)} onError={onError} />
            )}
            {route.kind === 'card' && !current && <p className="muted pad">This card doesn’t exist.</p>}
          </div>
        </aside>
      )}

      {showSettings && <SettingsDialog settings={settings} onClose={() => setShowSettings(false)} onError={onError} />}
      {toast && <div className="toast" role="alert" onClick={() => setToast(null)}>{toast}</div>}
    </div>
  );
}
