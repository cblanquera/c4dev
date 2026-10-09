/**
 * Choosing a folder on this machine. A browser's own folder picker never
 * reveals a folder's real path, so folders are listed by the factory's server
 * (names only). Git repositories are marked.
 */
import { Icon } from './Icon.tsx';
import { useEffect, useRef, useState } from 'react';
import { api, type FolderListing } from '../api.ts';

interface Props {
  /** Where to start; empty starts at the home folder. */
  start: string;
  onChoose: (path: string) => void;
  onClose: () => void;
}

export function FolderPicker({ start, onChoose, onClose }: Props) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [typed, setTyped] = useState(start);
  const [hidden, setHidden] = useState(false);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  /** Only the latest request may show its folders; a slower earlier one must not overwrite it. */
  const latest = useRef(0);
  /** The path was typed into since the last request started; a response must not overwrite it. */
  const edited = useRef(false);

  async function open(path: string, showHidden = hidden, fallback?: string) {
    const request = ++latest.current;
    edited.current = false;
    try {
      const next = await api.folders(path, showHidden);
      if (request !== latest.current) return;
      setListing(next);
      if (!edited.current) setTyped(next.path);
      setFilter('');
      setError('');
    } catch (err) {
      if (request !== latest.current) return;
      if (fallback !== undefined) return void open(fallback, showHidden);
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  useEffect(() => {
    // Start in the current folder, or the home folder when it doesn't exist.
    void open(start, false, '');
  }, []);

  return (
    <div className="modal-backdrop stacked" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-narrow folder-picker" role="dialog" aria-modal="true" aria-labelledby="folder-picker-title">
        <header className="modal-head">
          <h2 id="folder-picker-title">Choose a folder</h2>
          <button className="ghost" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </header>
        <div className="modal-body folder-body">
          <form className="folder-path" onSubmit={(e) => { e.preventDefault(); void open(typed); }}>
            <button type="button" className="ghost small" aria-label="Up one folder" title="Up one folder" disabled={!listing?.parent} onClick={() => listing?.parent && open(listing.parent)}><Icon name="arrow-left" size={14} /></button>
            <input className="mono" aria-label="Folder path" value={typed} onChange={(e) => { edited.current = true; setTyped(e.target.value); }} />
            <button type="button" className="ghost small" onClick={() => open(listing?.home ?? '')}>Home</button>
          </form>
          {error && <p className="error-text" role="alert">{error}</p>}
          {listing?.git && <p className="small folder-git"><Icon name="check" size={12} /> This folder is a git repository.</p>}
          {listing && listing.dirs.length > 12 && (
            <input type="search" aria-label="Filter folders" placeholder={`Filter ${listing.dirs.length} folders`} value={filter} onChange={(e) => setFilter(e.target.value)} />
          )}
          <ul className="folder-list" aria-label="Folders">
            {listing?.dirs.filter((d) => !filter || d.name.toLowerCase().includes(filter.toLowerCase())).map((d) => (
              <li key={d.path}>
                <button className="folder-entry" onClick={() => open(d.path)} onDoubleClick={() => onChoose(d.path)} aria-label={`${d.name}${d.git ? ', git repository' : ''}`}>
                  <Icon name="chevron-right" size={14} />
                  <span>{d.name}</span>
                  {d.git && <span className="badge subtle">git</span>}
                </button>
              </li>
            ))}
            {listing && !listing.dirs.length && <li className="muted small">No folders here.</li>}
          </ul>
          {listing?.truncated && <p className="muted small">Not every folder is listed here; type a path above to go straight to it.</p>}
          <label className="folder-hidden small"><input type="checkbox" checked={hidden} onChange={(e) => { setHidden(e.target.checked); if (listing) void open(listing.path, e.target.checked); }} /> Show hidden folders</label>
        </div>
        <footer className="modal-foot">
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!listing} onClick={() => listing && onChoose(listing.path)}>Use this folder</button>
        </footer>
      </div>
    </div>
  );
}
