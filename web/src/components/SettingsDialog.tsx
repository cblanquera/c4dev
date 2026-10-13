/** Project configuration: target repo, agents, team and quality gates. */
import { Icon } from './Icon.tsx';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api } from '../api.ts';
import { Avatar } from './Avatar.tsx';
import { usageLine } from '../format.ts';
import { ROLE_GROUPS, profileTitle } from '../agents.ts';
import { useChooseFolder } from './FolderPicker.tsx';
import { ProjectLogo } from './ProjectLogo.tsx';
import { BudgetFields } from './BudgetFields.tsx';
import { UsageReport } from './UsageReport.tsx';
import type { AgentProfile, Project, Settings, UsageTotals } from '../../../server/types.ts';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

type Section = 'project' | 'team' | 'quality' | 'usage';
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'project', label: 'Project' },
  { id: 'team', label: 'Team' },
  { id: 'quality', label: 'Quality gates' },
];

interface Props {
  /** null creates a new project from `defaults`. */
  project: Project | null;
  defaults: Settings;
  /** Profiles to choose the team from. */
  profiles: AgentProfile[];
  /** This project's usage since the 1st of the month. */
  monthUsage?: UsageTotals;
  /** Changes whenever a run is recorded, so the Usage section refreshes. */
  usageVersion?: number;
  onClose: () => void;
  onSaved: (project: Project) => void;
  onError: (m: string) => void;
}

export function SettingsDialog({ project, defaults, profiles, monthUsage, usageVersion = 0, onClose, onSaved, onError }: Props) {
  // A new project has no usage yet.
  const sections = project ? [...SECTIONS, { id: 'usage' as const, label: 'Usage' }] : SECTIONS;
  const [name, setName] = useState(project?.name ?? '');
  // A new project needs its own repository; the demo default would collide.
  const [draft, setDraft] = useState<Settings>(project?.settings ?? { ...defaults, repoPath: '' });
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState<Section>('project');
  const folders = useChooseFolder((path) => set('repoPath', path), onError);
  const logoInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  async function uploadLogo(file: File) {
    setUploading(true);
    try {
      set('logoUrl', await api.upload(file));
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }
  const missing = !name.trim() || !draft.repoPath.trim();
  const [teamUsage, setTeamUsage] = useState<Record<number, UsageTotals>>({});
  useEffect(() => {
    if (!project) return;
    let live = true;
    api.projectUsage(project.id).then((u) => live && setTeamUsage(u.byProfile)).catch(() => {});
    return () => { live = false; };
  }, [project?.id]);
  const workers = profiles.filter((p) => !p.archived && p.job !== 'assistant');
  const everyone = !draft.team.length;
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
      if (/name|repositor|path/i.test(message)) setSection('project');
      onError(message);
    } finally {
      setSaving(false);
    }
  }

  /** Up/Down move between sections, as in a vertical tab list. */
  function onNavKey(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = sections.findIndex((x) => x.id === section);
    const next = sections[(i + (e.key === 'ArrowDown' ? 1 : sections.length - 1)) % sections.length].id;
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
            {sections.map((x) => (
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
              <div className="field">
                <span className="field-label" id="project-logo-label">Logo</span>
                <div className="logo-field">
                  <span className="logo-preview"><ProjectLogo url={draft.logoUrl} name={name || 'Project'} size={44} /></span>
                  <div className="logo-inputs">
                    <div className="path-row">
                      <input className="mono" aria-labelledby="project-logo-label" aria-describedby="project-logo-hint" placeholder="https://example.com/logo.png"
                        value={draft.logoUrl.startsWith('/uploads/') ? '' : draft.logoUrl} onChange={(e) => set('logoUrl', e.target.value)} />
                      <button type="button" className="secondary" disabled={uploading} onClick={() => logoInput.current?.click()}>
                        <Icon name="image-plus" size={14} /> {uploading ? 'Uploading…' : 'Upload'}
                      </button>
                      {draft.logoUrl && <button type="button" className="ghost" onClick={() => set('logoUrl', '')}>Remove</button>}
                    </div>
                    <span className="field-hint" id="project-logo-hint">{draft.logoUrl.startsWith('/uploads/') ? 'Using an uploaded image. ' : ''}Upload an image or paste a link to one. Shown on the board and the home screen; empty uses the factory's mark.</span>
                    <input ref={logoInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" hidden aria-label="Logo image" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadLogo(f); e.target.value = ''; }} />
                  </div>
                </div>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="project-path">Project path</label>
                <div className="path-row">
                  <input id="project-path" className="mono" aria-describedby="project-path-hint" value={draft.repoPath} onChange={(e) => set('repoPath', e.target.value)} />
                  <button type="button" className="secondary" disabled={folders.busy} onClick={() => folders.choose(draft.repoPath, 'Choose the project folder')}>{folders.busy ? 'Choosing…' : 'Choose…'}</button>
                </div>
                <span className="field-hint" id="project-path-hint">The project's git repository. Worktrees are created next to the factory data, not inside it.</span>
              </div>
              <div className="grid2">
                <Field label="Base branch"><input className="mono" value={draft.baseBranch} onChange={(e) => set('baseBranch', e.target.value)} /></Field>
                <Field label="When complete">
                  <select value={draft.onComplete} onChange={(e) => set('onComplete', e.target.value as Settings['onComplete'])}>
                    <option value="keep">Keep the card branch</option>
                    <option value="merge">Merge into base branch</option>
                  </select>
                </Field>
              </div>
              <Field label="Remote" hint={project?.remoteUrl ? `Pull and Push use ${project.remoteUrl}, with this machine's git credentials.` : 'The git remote to pull from and push to, e.g. origin. Pull and Push appear when the repository has it.'}>
              <input className="mono" value={draft.remote} onChange={(e) => set('remote', e.target.value)} />
            </Field>
            <Field label="Worktree setup command" hint="Runs in every new worktree, e.g. npm ci">
                <input className="mono" value={draft.setupCommand} onChange={(e) => set('setupCommand', e.target.value)} />
              </Field>
            </fieldset>}

            {section === 'team' && <fieldset>
            <legend>Team</legend>
            <div className="grid2">
              <Field label="Cards in flight" hint="Max cards past the Backlog at once"><input min={1} max={20} {...num('maxActiveCards')} /></Field>
              <Field label="Workers" hint="Max concurrent worker agents"><input min={1} max={32} {...num('maxWorkers')} /></Field>
            </div>
            <p className="field-hint">
              {everyone ? 'Every agent can work on this project. Choose agents to limit who does, and who spends tokens here.' : 'Only the chosen agents work on this project.'}
              {' '}Without a designer or auditor, developers take that work.
            </p>
            {ROLE_GROUPS.map(({ label, jobs }) => {
              const list = workers.filter((p) => jobs.includes(p.job));
              if (!list.length) return null;
              return (
                <div key={label} className="team-group" role="group" aria-label={label}>
                  <span className="field-label">{label}</span>
                  {list.map((p) => (
                    <label key={p.id} className="team-option">
                      <input type="checkbox" checked={draft.team.includes(p.id)}
                        onChange={(e) => set('team', e.target.checked ? [...draft.team, p.id] : draft.team.filter((id) => id !== p.id))} />
                      <Avatar name={p.name} imageUrl={p.imageUrl} size={24} />
                      <span className="team-option-name">{p.name}<span className="muted small"> · {profileTitle(p)}{p.model ? ` · ${p.model}` : ''}</span></span>
                      {project && teamUsage[p.id] && <span className="muted small">{usageLine(teamUsage[p.id])}</span>}
                    </label>
                  ))}
                </div>
              );
            })}
            {!everyone && <button className="link small" onClick={() => set('team', [])}>Let every agent work here</button>}
            <div className="team-group" role="group" aria-label="Monthly budget">
              <span className="field-label">Monthly budget</span>
              <BudgetFields id="project-budget" usd={draft.budgetUsd} tokens={draft.budgetTokens} month={monthUsage}
                reached="the coordinator pauses and cards wait in Deliverables until you raise it"
                onChange={({ usd, tokens }) => setDraft((d) => ({ ...d, budgetUsd: usd, budgetTokens: tokens }))} />
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
              <Field label="Architect review passes" hint="One focus per line. Each line is a separate review pass.">
                <textarea rows={4} value={draft.auditLenses.join('\n')} onChange={(e) => set('auditLenses', e.target.value.split('\n'))} />
              </Field>
              <div className="grid2">
                <Field label="Max loops" hint="Bounces back to In Progress before asking you for help"><input min={1} max={50} {...num('maxLoops')} /></Field>
                <Field label="Keep Complete visible (days)"><input min={1} max={365} {...num('completeRetentionDays')} /></Field>
              </div>
            </fieldset>}

            {section === 'usage' && project && <fieldset>
              <legend>Usage</legend>
              <UsageReport projectId={project.id} version={usageVersion} onError={onError} />
            </fieldset>}
          </div>
        </div>
        <footer className="modal-foot">
          {missing && <span className="muted small">Name and project path are required (Project).</span>}
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={saving || missing} onClick={save}>{project ? 'Save settings' : 'Create project'}</button>
        </footer>
        {folders.picker}
      </div>
    </div>
  );
}
