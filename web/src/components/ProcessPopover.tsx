/** Live project server inventory with scoped stop controls. */
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import type { ProjectProcess } from '../../../server/types.ts';
import { Icon } from './Icon.tsx';

export function ProcessPopover({ onError }: { onError: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [processes, setProcesses] = useState<ProjectProcess[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    if (!open) return;
    let live = true;
    let request: AbortController | undefined;
    const load = async () => {
      request?.abort();
      const controller = new AbortController();
      request = controller;
      setLoading(true);
      try {
        const result = await api.processes(controller.signal);
        if (!live || controller.signal.aborted) return;
        setProcesses(result.processes);
        setError('');
      } catch (err) {
        if (live && !controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load processes');
      } finally {
        if (live && request === controller) setLoading(false);
      }
    };
    refresh.current = () => { void load(); };
    void load();
    const interval = setInterval(() => { void load(); }, 5000);
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape, true);
    return () => {
      live = false;
      request?.abort();
      clearInterval(interval);
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);

  /** Stop only the selected server, then fetch the current inventory. */
  async function stop(process: ProjectProcess) {
    setStopping(process.id);
    try {
      const result = await api.stopProcess(process.id);
      if (result.disconnects) {
        setOpen(false);
        onError('Factory API stopped. Restart it to reconnect.');
      } else {
        setProcesses((current) => current.filter((item) => item.id !== process.id));
        refresh.current();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not stop this process');
      refresh.current();
    } finally {
      setStopping(null);
    }
  }

  return (
    <div className="process-control" ref={container}>
      <button ref={trigger} className="ghost" aria-label="Background processes" title="Background processes" aria-expanded={open} aria-controls="project-processes" onClick={() => setOpen((value) => !value)}><Icon name="terminal" /></button>
      {open && <div id="project-processes" className="process-popover" role="dialog" aria-label="Background processes">
        <header><h3>Background processes</h3><button className="ghost small" aria-label="Refresh processes" disabled={loading || !!stopping} onClick={() => refresh.current()}><Icon name="rotate-ccw" size={14} /></button><button className="ghost small" aria-label="Close processes" onClick={() => { setOpen(false); trigger.current?.focus(); }}><Icon name="x" size={14} /></button></header>
        <p className="muted small">Managed servers for this project and its repository.</p>
        {error && <p className="error-text" role="alert">{error}</p>}
        {loading && !processes.length && !error && <p className="muted small" role="status">Loading processes…</p>}
        {!loading && !error && !processes.length && <p className="muted small">No running background processes.</p>}
        <ul className="process-list">
          {processes.map((process) => <li key={process.id}>
            <div><strong>{process.summary}</strong><a href={process.url} target="_blank" rel="noreferrer">{process.url}</a><span className="muted small">PID {process.pid ?? 'pending'}{process.stopsAt ? ` · Stops ${new Date(process.stopsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</span>{process.currentServer && <span className="muted small">Stopping this API disconnects the factory.</span>}</div>
            <button className="danger secondary small" disabled={!!stopping} aria-label={`Stop ${process.summary}`} onClick={() => stop(process)}><Icon name="square" size={14} />{stopping === process.id ? 'Stopping…' : 'Stop'}</button>
          </li>)}
        </ul>
      </div>}
    </div>
  );
}
