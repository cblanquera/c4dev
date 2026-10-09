/** Project configuration (target repo, agents, quality gates) and the assistant's own driver. */
import { Icon } from './Icon.tsx';
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { api } from '../api.ts';
import type { AssistantSettings, Project, Settings } from '../../../server/types.ts';

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

type Section = 'project' | 'agents' | 'quality';
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'project', label: 'Project' },
  { id: 'agents', label: 'Agents' },
  { id: 'quality', label: 'Quality gates' },
];

interface Props {
  /** null creates a new project from `defaults`. */
  project: Project | null;
  defaults: Settings;
  onClose: () => void;
  onSaved: (project: Project) => void;
  onError: (m: string) => void;
}

export function SettingsDialog({ project, defaults, onClose, onSaved, onError }: Props) {
  const [name, setName] = useState(project?.name ?? '');
  // A new project needs its own repository; the demo default would collide.
  const [draft, setDraft] = useState<Settings>(project?.settings ?? { ...defaults, repoPath: '' });
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState<Section>('project');
  const missing = !name.trim() || !draft.repoPath.trim();
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const num = (key: keyof Settings) => ({
    type: 'number' as const,
    value: draft[key] as number,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, Number(e.target.value) as never),
  });

  async function save() {
    setSaving(true);
    try {
      const body = { name: name.trim(), settings: draft };
      onSaved(project ? await api.updateProject(project.id, body) : await api.createProject(body));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed';
      // Name and repository problems are fixed in the Project section.
      if (/name|repositor/i.test(message)) setSection('project');
      onError(message);
    } finally {
      setSaving(false);
    }
  }

  /** Up/Down move between sections, as in a vertical tab list. */
  function onNavKey(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = SECTIONS.findIndex((x) => x.id === section);
    const next = SECTIONS[(i + (e.key === 'ArrowDown' ? 1 : SECTIONS.length - 1)) % SECTIONS.length].id;
    setSection(next);
    document.getElementById(`settings-tab-${next}`)?.focus();
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="modal-head">
          <h2 id="settings-title">{project ? 'Project settings' : 'New project'}</h2>
          <button className="ghost" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </header>
        <div className="settings-layout">
          <nav className="settings-nav" role="tablist" aria-orientation="vertical" aria-label="Settings sections" onKeyDown={onNavKey}>
            {SECTIONS.map((x) => (
              <button key={x.id} id={`settings-tab-${x.id}`} role="tab" aria-selected={section === x.id} aria-controls="settings-panel"
                tabIndex={section === x.id ? 0 : -1} className={section === x.id ? 'active' : ''} onClick={() => setSection(x.id)}>{x.label}</button>
            ))}
          </nav>
          <div className="modal-body settings-panel" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${section}`}>
            {section === 'project' && <fieldset>
              <legend>Project</legend>
              <Field label="Name">
                <input value={name} onChange={(e) => setName(e.target.value)} autoFocus={!project} />
              </Field>
              <Field label="Repository path" hint="Absolute path to the git repo the agents work on. Worktrees are created next to the factory data, not inside it.">
                <input className="mono" value={draft.repoPath} onChange={(e) => set('repoPath', e.target.value)} />
              </Field>
              <div className="grid2">
                <Field label="Base branch"><input className="mono" value={draft.baseBranch} onChange={(e) => set('baseBranch', e.target.value)} /></Field>
                <Field label="When complete">
                  <select value={draft.onComplete} onChange={(e) => set('onComplete', e.target.value as Settings['onComplete'])}>
                    <option value="keep">Keep the card branch</option>
                    <option value="merge">Merge into base branch</option>
                  </select>
                </Field>
              </div>
              <Field label="Worktree setup command" hint="Runs in every new worktree, e.g. npm ci">
                <input className="mono" value={draft.setupCommand} onChange={(e) => set('setupCommand', e.target.value)} />
              </Field>
            </fieldset>}

            {section === 'agents' && <fieldset>
              <legend>Agents</legend>
              <Field label="Driver" hint={draft.driver === 'simulated' ? 'Simulated agents write harmless notes instead of code. No API calls, no cost.' : 'Real Claude agents via the Claude Agent SDK. Workers can edit files and run commands inside their worktrees.'}>
                <select value={draft.driver} onChange={(e) => set('driver', e.target.value as Settings['driver'])}>
                  <option value="simulated">Simulated (demo)</option>
                  <option value="claude">Claude Agent SDK</option>
                </select>
              </Field>
              <div className="grid2">
                <Field label="Coordinator & worker model"><input className="mono" value={draft.model} onChange={(e) => set('model', e.target.value)} /></Field>
                <Field label="Senior auditor model"><input className="mono" value={draft.seniorModel} onChange={(e) => set('seniorModel', e.target.value)} /></Field>
                <Field label="Cards in flight" hint="Max cards past the Backlog at once"><input min={1} max={20} {...num('maxActiveCards')} /></Field>
                <Field label="Workers" hint="Max concurrent worker agents"><input min={1} max={32} {...num('maxWorkers')} /></Field>
              </div>
            </fieldset>}

            {section === 'quality' && <fieldset>
              <legend>Quality gates</legend>
              <Field label="Test command"><input className="mono" value={draft.testCommand} onChange={(e) => set('testCommand', e.target.value)} /></Field>
              <Field label="Coverage command" hint="Must print a coverage table (istanbul, c8, node --test, pytest-cov, go) or write coverage/coverage-summary.json. Leave empty to skip.">
                <input className="mono" value={draft.coverageCommand} onChange={(e) => set('coverageCommand', e.target.value)} />
              </Field>
              <div className="grid2">
                <Field label="Minimum coverage %"><input min={0} max={100} {...num('coverageMin')} /></Field>
                <Field label="Target coverage %"><input min={0} max={100} {...num('coverageTarget')} /></Field>
              </div>
              <Field label="Acceptance command" hint="{card} expands to the card id, e.g. npx playwright test acceptance/card-{card}">
                <input className="mono" value={draft.acceptanceCommand} onChange={(e) => set('acceptanceCommand', e.target.value)} />
              </Field>
              <Field label="Senior audit passes" hint="One focus per line. Each line is a separate audit pass.">
                <textarea rows={4} value={draft.auditLenses.join('\n')} onChange={(e) => set('auditLenses', e.target.value.split('\n'))} />
              </Field>
              <div className="grid2">
                <Field label="Max loops" hint="Bounces back to In Progress before asking you for help"><input min={1} max={50} {...num('maxLoops')} /></Field>
                <Field label="Keep Complete visible (days)"><input min={1} max={365} {...num('completeRetentionDays')} /></Field>
              </div>
            </fieldset>}
          </div>
        </div>
        <footer className="modal-foot">
          {missing && <span className="muted small">Name and repository path are required (Project).</span>}
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={saving || missing} onClick={save}>{project ? 'Save settings' : 'Create project'}</button>
        </footer>
      </div>
    </div>
  );
}

/** The assistant answers for every project, so its driver is set separately from theirs. */
export function AssistantSettingsDialog({ settings, onClose, onError }: { settings: AssistantSettings; onClose: () => void; onError: (m: string) => void }) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.assistantSettings(draft);
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="assistant-settings-title">
        <header className="modal-head">
          <h2 id="assistant-settings-title">Assistant settings</h2>
          <button className="ghost" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </header>
        <div className="modal-body">
          <fieldset>
            <legend>Agent</legend>
            <Field label="Driver" hint={draft.driver === 'simulated' ? 'Answers fixed phrasings. No API calls, no cost.' : 'A Claude agent that reads every board. It has no repository or file access.'}>
              <select value={draft.driver} onChange={(e) => setDraft((d) => ({ ...d, driver: e.target.value as AssistantSettings['driver'] }))}>
                <option value="simulated">Simulated (demo)</option>
                <option value="claude">Claude Agent SDK</option>
              </select>
            </Field>
            <Field label="Model"><input className="mono" value={draft.model} onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))} /></Field>
          </fieldset>
        </div>
        <footer className="modal-foot">
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={saving || !draft.model.trim()} onClick={save}>Save settings</button>
        </footer>
      </div>
    </div>
  );
}
