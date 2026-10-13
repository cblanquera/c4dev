/**
 * Agents in Settings: every profile with its picture, title, skills, projects
 * and usage, and an editor for its name, picture, role, title, brief, model,
 * skills and contexts (MCP servers). The Chief of Staff, who runs the assistant, is shown first; it
 * keeps its role and can't be deleted.
 */
import { Icon } from './Icon.tsx';
import { useRef, useState, type KeyboardEvent } from 'react';
import { api, type ProfileInput } from '../api.ts';
import { Avatar } from './Avatar.tsx';
import { usageLine } from '../format.ts';
import { NO_USAGE } from '../store.ts';
import { ModelInput, ProviderSelect } from './ProviderPicker.tsx';
import { BudgetFields } from './BudgetFields.tsx';
import { AGENT_JOBS, JOB_LABELS, type AgentJob, type AgentProfile, type Context, type Project, type ProviderStatus, type Skill, type UsageTotals } from '../../../server/types.ts';
import { JOB_CONTEXT, ROLE_GROUPS, assistantOf, profileTitle, providerLabel } from '../agents.ts';

/** Roles that can be chosen: there's only one Chief of Staff. */
const CHOOSABLE_JOBS = AGENT_JOBS.filter((job) => job !== 'assistant');

/** "Architect · Claude · claude-opus-5-5", with the role after a custom job title. */
function profileLine(profile: AgentProfile): string {
  const role = profile.title && profile.title !== JOB_LABELS[profile.job] ? ` (${JOB_LABELS[profile.job]})` : '';
  return `${profileTitle(profile)}${role} · ${providerLabel(profile.provider)}${profile.model ? ` · ${profile.model}` : ''}`;
}

/** Projects a profile works on: those that chose it, or every project without a chosen team. */
function projectsOf(profile: AgentProfile, projects: Project[]): Project[] {
  if (profile.job === 'assistant') return projects;
  return projects.filter((p) => !p.settings.team.length || p.settings.team.includes(profile.id));
}

interface SectionProps {
  profiles: AgentProfile[];
  skills: Map<number, Skill>;
  contexts: Map<number, Context>;
  projects: Project[];
  usage: Record<number, UsageTotals>;
  /** Usage per agent since the 1st of the month. */
  monthUsage: Record<number, UsageTotals>;
  providers: ProviderStatus[];
  onError: (message: string) => void;
}

export function AgentsSection({ profiles, skills, contexts, projects, usage, monthUsage, providers, onError }: SectionProps) {
  /** The agent being edited, a new one (blank, or `initial` when copying), or nothing. */
  const [editing, setEditing] = useState<AgentProfile | 'new' | { copy: ProfileInput } | null>(null);
  const isNew = editing === 'new' || (!!editing && 'copy' in editing);
  const existing = editing && editing !== 'new' && !('copy' in editing) ? editing : null;
  const chief = assistantOf(profiles);
  const groups = ROLE_GROUPS.map((g) => ({ ...g, list: profiles.filter((p) => g.jobs.includes(p.job) && !p.archived && p.id !== chief?.id) })).filter((g) => g.list.length);
  return (
    <div className="agents-section">
      <div className="agents-head">
        <p className="field-hint">Named agents do every run. Choose which work on each project in its settings.</p>
        <button className="primary small" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> New agent</button>
      </div>
      {chief && (
        <section className="agent-group" aria-label="Chief of Staff">
          <h3>Chief of Staff</h3>
          <button className="agent-tile chief" onClick={() => setEditing(chief)} aria-label={`Edit ${chief.name}`}>
            <Avatar name={chief.name} imageUrl={chief.imageUrl} size={44} />
            <span className="agent-tile-body">
              <strong>{chief.name}</strong>
              <span className="muted small">{profileLine(chief)}</span>
              <span className="muted small">Your assistant on the home screen. Answers for every project, without repository access.</span>
              <span className="muted small">{usageLine(usage[chief.id] ?? NO_USAGE)}</span>
            </span>
            <span className="chief-badge"><Icon name="sparkles" size={12} /> Assistant</span>
          </button>
        </section>
      )}
      {groups.map(({ label, list }) => (
        <section key={label} className="agent-group" aria-label={label}>
          <h3>{label}</h3>
          <ul className="agent-grid">
            {list.map((profile) => {
              const works = projectsOf(profile, projects);
              return (
                <li key={profile.id}>
                  <button className="agent-tile" onClick={() => setEditing(profile)} aria-label={`Edit ${profile.name}`}>
                    <Avatar name={profile.name} imageUrl={profile.imageUrl} size={44} />
                    <span className="agent-tile-body">
                      <strong>{profile.name}</strong>
                      <span className="muted small">{profileLine(profile)}</span>
                      {profile.skillIds.length > 0 && (
                        <span className="agent-skills">{profile.skillIds.map((id) => skills.get(id)).filter((s) => !!s).map((s) => <span key={s!.id} className="chip">{s!.name}</span>)}</span>
                      )}
                      {profile.contextIds.length > 0 && (
                        <span className="agent-skills" aria-label="Contexts">{profile.contextIds.map((id) => contexts.get(id)).filter((c) => !!c).map((c) => <span key={c!.id} className="chip chip-context"><Icon name="plug" size={12} /> {c!.name}</span>)}</span>
                      )}
                      <span className="muted small">{works.length === projects.length ? 'All projects' : works.map((p) => p.name).join(', ') || 'No projects'}</span>
                      <span className="muted small">{usageLine(usage[profile.id] ?? NO_USAGE)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {editing && (
        <ProfileEditor key={existing ? existing.id : `new-${isNew && editing !== 'new' ? 'copy' : 'blank'}`} profile={existing}
          initial={editing !== 'new' && 'copy' in editing ? editing.copy : undefined} skills={skills} contexts={contexts} projects={projects} providers={providers}
          usage={existing ? usage[existing.id] ?? NO_USAGE : NO_USAGE} monthUsage={existing ? monthUsage[existing.id] ?? NO_USAGE : NO_USAGE}
          onCopy={(draft) => setEditing({ copy: { ...draft, name: `${draft.name} (copy)` } })} onClose={() => setEditing(null)} onError={onError} />
      )}
    </div>
  );
}

type Section = 'profile' | 'context' | 'skills' | 'contexts' | 'usage';

interface EditorProps {
  profile: AgentProfile | null;
  /** A new agent's starting values, e.g. a copy of another agent. */
  initial?: ProfileInput;
  /** Opens a new agent pre-filled with this one's current values. */
  onCopy?: (draft: ProfileInput) => void;
  skills: Map<number, Skill>;
  contexts: Map<number, Context>;
  projects: Project[];
  providers: ProviderStatus[];
  usage: UsageTotals;
  monthUsage: UsageTotals;
  onClose: () => void;
  onError: (message: string) => void;
}

const UPLOAD_TYPES = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml';

export function ProfileEditor({ profile, initial, onCopy, skills, contexts, projects, providers, usage, monthUsage, onClose, onError }: EditorProps) {
  const [draft, setDraft] = useState<ProfileInput>(initial ?? (profile
    ? {
      name: profile.name, job: profile.job, title: profile.title, provider: profile.provider, context: profile.context, imageUrl: profile.imageUrl,
      model: profile.model, skillIds: profile.skillIds, contextIds: profile.contextIds, budgetUsd: profile.budgetUsd, budgetTokens: profile.budgetTokens,
    }
    : { name: '', job: 'developer', title: '', provider: 'simulated', context: '', imageUrl: null, model: '', skillIds: [], contextIds: [], budgetUsd: 0, budgetTokens: 0 }));
  const [section, setSection] = useState<Section>('profile');
  const [skillQuery, setSkillQuery] = useState('');
  const [contextQuery, setContextQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const sections: { id: Section; label: string }[] = [
    { id: 'profile', label: 'Profile' }, { id: 'context', label: 'Brief' }, { id: 'skills', label: 'Skills' }, { id: 'contexts', label: 'Contexts' }, { id: 'usage', label: 'Usage' },
  ];
  const chief = profile?.job === 'assistant';
  const set = <K extends keyof ProfileInput>(key: K, value: ProfileInput[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const library = [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  const query = skillQuery.trim().toLowerCase();
  const matching = library.filter((skill) => !query || `${skill.name} ${skill.description}`.toLowerCase().includes(query));
  const contextLibrary = [...contexts.values()].sort((a, b) => a.name.localeCompare(b.name));
  const contextSearch = contextQuery.trim().toLowerCase();
  const contextMatches = contextLibrary.filter((c) => !contextSearch || [c.name, c.description, c.folder, c.url, c.command].join(' ').toLowerCase().includes(contextSearch));
  // Read-only roles only ever start read-only contexts (server/agents/driver.ts).
  const writes = draft.job === 'developer' || draft.job === 'auditor';

  async function run(fn: () => Promise<unknown>) {
    setSaving(true);
    try {
      await fn();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSaving(false);
    }
  }

  /** Moving off the simulation spends real money or quota, so it's confirmed. */
  function confirmPaid(): boolean {
    if (draft.provider === 'simulated' || (profile && profile.provider !== 'simulated')) return true;
    const label = providerLabel(draft.provider);
    const cap = draft.budgetUsd || draft.budgetTokens
      ? `Its monthly budget (Usage) caps it at ${[draft.budgetUsd ? `$${draft.budgetUsd}` : '', draft.budgetTokens ? `${draft.budgetTokens.toLocaleString()} tokens` : ''].filter(Boolean).join(' and ')}.`
      : 'It has no monthly budget; you can set one in its Usage tab.';
    return confirm(`${draft.name || 'This agent'} will run on ${label}, using this machine's ${label} login. Its runs may cost money. ${cap} Continue?`);
  }

  const save = () => confirmPaid() && run(async () => {
    await (profile ? api.updateProfile(profile.id, draft) : api.createProfile(draft));
    onClose();
  });

  const uploadImage = (file: File) => run(async () => set('imageUrl', await api.upload(file)));

  function onNavKey(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = sections.findIndex((x) => x.id === section);
    const next = sections[(i + (e.key === 'ArrowDown' ? 1 : sections.length - 1)) % sections.length].id;
    setSection(next);
    document.getElementById(`profile-tab-${next}`)?.focus();
  }

  return (
    <div className="modal-backdrop stacked" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-settings" role="dialog" aria-modal="true" aria-labelledby="profile-title">
        <header className="modal-head">
          <Avatar name={draft.name || '?'} imageUrl={draft.imageUrl} size={28} />
          <h2 id="profile-title">{profile ? `Edit ${profile.name}` : 'New agent'}</h2>
          <button className="ghost" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </header>
        <div className="settings-layout">
          <nav className="settings-nav" role="tablist" aria-orientation="vertical" aria-label="Agent sections" onKeyDown={onNavKey}>
            {sections.map((x) => (
              <button key={x.id} id={`profile-tab-${x.id}`} role="tab" aria-selected={section === x.id} aria-controls="profile-panel"
                tabIndex={section === x.id ? 0 : -1} className={section === x.id ? 'active' : ''} onClick={() => setSection(x.id)}>{x.label}</button>
            ))}
          </nav>
          <div className="modal-body settings-panel" id="profile-panel" role="tabpanel" aria-labelledby={`profile-tab-${section}`}>
            {section === 'profile' && <fieldset>
              <legend>Profile</legend>
              <div className="avatar-field">
                <Avatar name={draft.name || '?'} imageUrl={draft.imageUrl} size={72} />
                <div className="avatar-actions">
                  <button className="secondary small" onClick={() => imageInput.current?.click()}><Icon name="image-plus" size={14} /> {draft.imageUrl ? 'Change picture' : 'Add picture'}</button>
                  {draft.imageUrl && <button className="ghost small" onClick={() => set('imageUrl', null)}>Remove picture</button>}
                  <input ref={imageInput} type="file" accept={UPLOAD_TYPES} hidden aria-label="Picture" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImage(f); e.target.value = ''; }} />
                </div>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="profile-name">Name</label>
                <input id="profile-name" value={draft.name} onChange={(e) => set('name', e.target.value)} autoFocus={!profile} />
              </div>
              <div className="grid2">
                <div className="field">
                  <label className="field-label" htmlFor="profile-role">Role</label>
                  <select id="profile-role" aria-describedby="profile-role-hint" value={draft.job} disabled={chief} onChange={(e) => set('job', e.target.value as AgentJob)}>
                    {(chief ? ['assistant' as const] : CHOOSABLE_JOBS).map((job) => <option key={job} value={job}>{JOB_LABELS[job]}</option>)}
                  </select>
                  <span className="field-hint" id="profile-role-hint">{chief ? `${JOB_CONTEXT.assistant} The assistant always runs as this agent, so its role stays and it can't be deleted.` : JOB_CONTEXT[draft.job]}</span>
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="profile-job-title">Job title</label>
                  <input id="profile-job-title" aria-describedby="profile-job-title-hint" value={draft.title} placeholder={JOB_LABELS[draft.job]} onChange={(e) => set('title', e.target.value)} />
                  <span className="field-hint" id="profile-job-title-hint">Shown beside the name. Leave empty to show the role.</span>
                </div>
              </div>
              <div className="grid2">
                <div className="field">
                  <label className="field-label" htmlFor="profile-provider">Provider</label>
                  <ProviderSelect id="profile-provider" describedBy="profile-provider-hint" providers={providers} value={draft.provider}
                    onChange={(value) => setDraft((d) => ({ ...d, provider: value, model: value === d.provider ? d.model : '' }))} />
                  <span className="field-hint" id="profile-provider-hint">What runs this agent. Switch providers on in Settings → Providers.</span>
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="profile-model">Model</label>
                  <ModelInput id="profile-model" describedBy="profile-model-hint" providers={providers} provider={draft.provider} value={draft.model} onChange={(value) => set('model', value)}
                    placeholder="Provider's default model" />
                  <span className="field-hint" id="profile-model-hint">Leave empty for the provider's default.</span>
                </div>
              </div>
            </fieldset>}

            {section === 'context' && <fieldset>
              <legend>Brief</legend>
              <div className="field">
                <label className="field-label" htmlFor="profile-brief">Brief</label>
                <textarea id="profile-brief" aria-describedby="profile-brief-hint" rows={14} value={draft.context} onChange={(e) => set('context', e.target.value)}
                  placeholder={'How this agent should work: priorities, conventions, tone.\n\ne.g. Prefer small, readable functions. Always explain trade-offs in the summary.'} />
                <span className="field-hint" id="profile-brief-hint">Added to the instructions of every run this agent does. It can't override the role's rules or permissions.</span>
              </div>
            </fieldset>}

            {section === 'skills' && <fieldset>
              <legend>Skills</legend>
              <p className="field-hint">Attached skills load into this agent's sessions. Add skills to the library in Settings → Skills.</p>
              {library.length > 0 && (
                <input type="search" className="skill-search" aria-label="Search skills" placeholder={`Search ${library.length} skill${library.length === 1 ? '' : 's'}`}
                  value={skillQuery} onChange={(e) => setSkillQuery(e.target.value)} />
              )}
              {!library.length && <p className="muted small">The skills library is empty.</p>}
              {library.length > 0 && <p className="muted small" role="status">{draft.skillIds.length} attached{query ? ` · ${matching.length} match${matching.length === 1 ? '' : 'es'}` : ''}</p>}
              <ul className="skill-list">
                {matching.map((skill) => (
                  <li key={skill.id}>
                    <label className="skill-option">
                      <input type="checkbox" checked={draft.skillIds.includes(skill.id)}
                        onChange={(e) => set('skillIds', e.target.checked ? [...draft.skillIds, skill.id] : draft.skillIds.filter((id) => id !== skill.id))} />
                      <span><strong className="mono">{skill.name}</strong><span className="muted small">{skill.description || 'No description'}</span></span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>}

            {section === 'contexts' && <fieldset>
              <legend>Contexts</legend>
              <p className="field-hint">MCP servers and knowledge folders this agent's runs can use. Add them in Settings → Contexts.{writes ? '' : ' This role only reads, so it only gets read-only contexts.'}</p>
              {draft.provider === 'pi' && <p className="small provider-version"><Icon name="circle-alert" size={12} /> Pi can't use MCP servers, so its runs skip these.</p>}
              {contextLibrary.length > 0 && (
                <input type="search" className="skill-search" aria-label="Search contexts" placeholder={`Search ${contextLibrary.length} context${contextLibrary.length === 1 ? '' : 's'}`}
                  value={contextQuery} onChange={(e) => setContextQuery(e.target.value)} />
              )}
              {!contextLibrary.length && <p className="muted small">No contexts yet.</p>}
              {contextLibrary.length > 0 && (
                <p className="muted small" role="status">
                  {draft.contextIds.filter((id) => contexts.has(id)).length} attached{contextSearch ? ` · ${contextMatches.length} match${contextMatches.length === 1 ? '' : 'es'}` : ''}
                </p>
              )}
              <ul className="skill-list">
                {contextMatches.map((context) => (
                  <li key={context.id}>
                    <label className="skill-option">
                      <input type="checkbox" checked={draft.contextIds.includes(context.id)}
                        onChange={(e) => set('contextIds', e.target.checked ? [...draft.contextIds, context.id] : draft.contextIds.filter((id) => id !== context.id))} />
                      <span>
                        <strong className="mono">{context.name}</strong>
                        <span className="muted small">{context.description || (context.transport === 'folder' ? context.folder : context.transport === 'stdio' ? context.command : context.url)}{context.readOnly ? ' · read-only' : writes ? '' : ' · not used by this role'}{context.enabled ? '' : ' · switched off'}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>}

            {section === 'usage' && <fieldset>
              <legend>Usage</legend>
              {profile && <>
                <p>All time: {usageLine(usage)}</p>
                <p className="field-hint">Costs are the providers' estimates across every project; simulated runs cost nothing. Each project's settings show this agent's share there.</p>
                <p className="field-hint">Works on: {projectsOf(profile, projects).map((p) => p.name).join(', ') || 'no projects'}. Choose teams in each project's settings.</p>
              </>}
              <span className="field-label">Monthly budget</span>
              <BudgetFields id="profile-budget" usd={draft.budgetUsd} tokens={draft.budgetTokens} month={monthUsage}
                reached={draft.job === 'assistant' ? 'the assistant stops answering until you raise it' : 'work goes to others on the team, or waits in Deliverables until you raise it'}
                onChange={({ usd, tokens }) => setDraft((d) => ({ ...d, budgetUsd: usd, budgetTokens: tokens }))} />
            </fieldset>}
          </div>
        </div>
        <footer className="modal-foot">
          {profile && !chief && <button className="danger ghost" disabled={saving} onClick={() => confirm(`Delete ${profile.name}? Recorded activity keeps their name.`) && run(async () => { await api.removeProfile(profile.id); onClose(); })}>Delete</button>}
          <span className="spacer" />
          {/* There's only one Chief of Staff, so it can't be copied. */}
          {profile && !chief && onCopy && <button className="secondary" disabled={saving} onClick={() => onCopy(draft)}><Icon name="copy" size={14} /> Copy agent</button>}
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={saving || !draft.name.trim()} onClick={save}>{profile ? 'Save agent' : 'Create agent'}</button>
        </footer>
      </div>
    </div>
  );
}
