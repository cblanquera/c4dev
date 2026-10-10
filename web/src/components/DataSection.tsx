/**
 * Settings → Data: export the setup (skills, agents, projects) to move it to
 * another machine, import one, and take or find database backups.
 */
import { Icon } from './Icon.tsx';
import { useEffect, useRef, useState } from 'react';
import { api, type Backups } from '../api.ts';
import { importSummary } from './SkillsLibrary.tsx';

const bytes = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function DataSection({ onError }: { onError: (m: string) => void }) {
  const [busy, setBusy] = useState<'export' | 'import' | 'backup' | null>(null);
  const [result, setResult] = useState('');
  const [backups, setBackups] = useState<Backups | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const loadBackups = () => api.backups().then(setBackups).catch((err) => onError(err instanceof Error ? err.message : 'Failed'));
  useEffect(() => {
    void loadBackups();
  }, []);

  async function run(kind: 'export' | 'import' | 'backup', fn: () => Promise<void>) {
    setBusy(kind);
    try {
      await fn();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(null);
    }
  }

  const exportSetup = () => run('export', async () => {
    const data = await api.exportData();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    link.download = `factory-export-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  });

  const importSetup = (picked: File | undefined) => picked && run('import', async () => {
    setResult('');
    let data: unknown;
    try {
      data = JSON.parse(await picked.text());
    } catch {
      throw new Error(`${picked.name} isn't a factory export file`);
    }
    setResult(importSummary(await api.importData(data)));
  });

  const backUp = () => run('backup', async () => {
    await api.backup();
    await loadBackups();
  });

  return (
    <div className="settings-form data-section">
      <section aria-labelledby="data-export-title" className="data-block">
        <h3 id="data-export-title">Export and import</h3>
        <p className="field-hint">An export holds the skills library, every agent (pictures included) and each project's settings. Cards and secrets aren't included. Importing merges: skills and agents by name, the Chief of Staff by role, projects by folder.</p>
        <div className="settings-actions">
          <button className="secondary" disabled={!!busy} onClick={exportSetup}><Icon name="arrow-down-to-line" size={14} /> {busy === 'export' ? 'Exporting…' : 'Export setup'}</button>
          <button className="secondary" disabled={!!busy} onClick={() => file.current?.click()}><Icon name="arrow-up-from-line" size={14} /> {busy === 'import' ? 'Importing…' : 'Import setup'}</button>
          <input ref={file} type="file" accept="application/json,.json" hidden aria-label="Export file" onChange={(e) => { void importSetup(e.target.files?.[0]); e.target.value = ''; }} />
        </div>
        {result && <p className="skill-result small" role="status">{result}</p>}
      </section>
      <section aria-labelledby="data-backups-title" className="data-block">
        <h3 id="data-backups-title">Backups</h3>
        <p className="field-hint">The database is backed up before every upgrade, and whenever you ask. The latest ten are kept. To restore one, stop the factory and copy it over <code>factory.db</code>.</p>
        <p className="field-hint">Card secrets are encrypted with the key in <code className="mono">{backups?.keyFile ?? 'secret.key'}</code>. Keep a copy of it somewhere safe: without it, secrets in the database and its backups can't be read.</p>
        <div className="settings-actions">
          <button className="secondary" disabled={!!busy} onClick={backUp}><Icon name="copy" size={14} /> {busy === 'backup' ? 'Backing up…' : 'Back up now'}</button>
        </div>
        {backups && (
          <ul className="backup-list" aria-label="Backups">
            {!backups.backups.length && <li className="muted small">No backups yet.</li>}
            {backups.backups.map((b) => (
              <li key={b.name}>
                <span className="mono small">{b.name}</span>
                <span className="muted small">{new Date(b.createdAt).toLocaleString()} · {bytes(b.bytes)}</span>
              </li>
            ))}
          </ul>
        )}
        {backups && <p className="muted small mono provider-path" title={backups.dir}>{backups.dir}</p>}
      </section>
    </div>
  );
}
