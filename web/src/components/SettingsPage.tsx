/**
 * Settings that span projects, as a page of its own: the agents every project
 * can use (the assistant among them), the skills library and the agent
 * providers on this machine. Each section has an address (#settings/agents),
 * so back and links work.
 */
import { Icon } from './Icon.tsx';
import { useState } from 'react';
import { api } from '../api.ts';
import { AgentsSection } from './Agents.tsx';
import { SkillsLibrary } from './SkillsLibrary.tsx';
import { DataSection } from './DataSection.tsx';
import { ContextsSection } from './Contexts.tsx';
import { UsageReport } from './UsageReport.tsx';
import { goHome } from '../nav.ts';
import type { AgentProfile, Context, JevStatus, Project, ProviderStatus, RunLimits, Skill, UsageTotals } from '../../../server/types.ts';

export const SETTINGS_SECTIONS = [
  { id: 'agents', label: 'Agents' },
  { id: 'skills', label: 'Skills' },
  { id: 'contexts', label: 'Contexts' },
  { id: 'providers', label: 'Providers' },
  { id: 'usage', label: 'Usage' },
  { id: 'limits', label: 'Limits' },
  { id: 'data', label: 'Data' },
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id'];

interface Props {
  section: SettingsSection;
  profiles: AgentProfile[];
  skills: Map<number, Skill>;
  contexts: Map<number, Context>;
  projects: Project[];
  usage: Record<number, UsageTotals>;
  /** Usage per agent since the 1st of the month. */
  monthUsage: Record<number, UsageTotals>;
  limits: RunLimits | null;
  providers: ProviderStatus[];
  jev: JevStatus | null;
  usageVersion: number;
  onError: (m: string) => void;
}

export function SettingsPage({ section, profiles, skills, contexts, projects, usage, monthUsage, limits, providers, jev, usageVersion, onError }: Props) {
  const label = SETTINGS_SECTIONS.find((s) => s.id === section)!.label;
  return (
    <main className="settings-page" aria-labelledby="settings-section-title">
      <nav className="settings-page-nav" aria-label="Settings sections">
        <a className="settings-back" href="#" onClick={(e) => { e.preventDefault(); goHome(); }}><Icon name="arrow-left" size={14} /> Back to App</a>
        {SETTINGS_SECTIONS.map((s) => (
          <a key={s.id} href={`#settings/${s.id}`} className={s.id === section ? 'active' : ''} aria-current={s.id === section ? 'page' : undefined}>{s.label}</a>
        ))}
      </nav>
      <section className="settings-page-body">
        <h2 id="settings-section-title">{label}</h2>
        {section === 'agents' && <AgentsSection profiles={profiles} skills={skills} contexts={contexts} projects={projects} usage={usage} monthUsage={monthUsage} providers={providers} onError={onError} />}
        {section === 'skills' && <SkillsLibrary skills={skills} profiles={profiles} onError={onError} />}
        {section === 'contexts' && <ContextsSection contexts={contexts} profiles={profiles} onError={onError} />}
        {section === 'providers' && <ProvidersSection providers={providers} jev={jev} onError={onError} />}
        {section === 'usage' && <UsageReport version={usageVersion} onError={onError} />}
        {section === 'limits' && limits && <LimitsSection limits={limits} onError={onError} />}
        {section === 'data' && <DataSection onError={onError} />}
      </section>
    </main>
  );
}

/** Caps on every agent run. Budgets are set per project (Team) and per agent (Usage). */
function LimitsSection({ limits, onError }: { limits: RunLimits; onError: (m: string) => void }) {
  const [draft, setDraft] = useState(limits);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const changed = draft.maxTurns !== limits.maxTurns || draft.runMinutes !== limits.runMinutes;

  async function save() {
    setSaving(true);
    try {
      setDraft(await api.setLimits(draft));
      setSaved(true);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSaving(false);
    }
  }

  const set = (key: keyof RunLimits, value: string) => {
    setSaved(false);
    setDraft((d) => ({ ...d, [key]: Math.round(Number(value)) || 0 }));
  };

  return (
    <div className="settings-form">
      <p className="field-hint">Every agent run stops when it reaches either limit. A stopped run counts as a failed attempt, so it's retried a few times and then brought to you in Deliverables. Monthly budgets are set per project (project settings → Team) and per agent (its Usage tab).</p>
      <div className="grid2">
        <div className="field">
          <label className="field-label" htmlFor="limit-turns">Max turns per run</label>
          <input id="limit-turns" type="number" min={1} max={10000} value={draft.maxTurns || ''} onChange={(e) => set('maxTurns', e.target.value)} aria-describedby="limit-turns-hint" />
          <span className="field-hint" id="limit-turns-hint">Tool calls or model turns.</span>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="limit-minutes">Max minutes per run</label>
          <input id="limit-minutes" type="number" min={1} max={10000} value={draft.runMinutes || ''} onChange={(e) => set('runMinutes', e.target.value)} />
        </div>
      </div>
      <div className="settings-actions">
        <button className="primary" disabled={saving || !changed || draft.maxTurns < 1 || draft.runMinutes < 1} onClick={save}>{saving ? 'Saving…' : 'Save limits'}</button>
        {saved && !changed && <span className="muted small" role="status">Saved. New runs use these limits.</span>}
      </div>
    </div>
  );
}

/** Whether the installed CLI is the version the factory reads correctly. */
function VersionNote({ provider: p }: { provider: ProviderStatus }) {
  if (p.versionCheck === 'tested') return <span className="muted small">Tested with this version.</span>;
  const how = p.versionCheck === 'newer' ? 'newer than' : p.versionCheck === 'older' ? 'older than' : "a version we can't compare with";
  return (
    <span className="small provider-version">
      <Icon name="circle-alert" size={12} /> This is {how} the tested {p.tested}. Its output may differ: if runs fail, check it with <code>npm run smoke -- {p.id}</code>.
    </span>
  );
}

/** The agent CLIs on this machine: installed or not, and switched on or off. */
function ProvidersSection({ providers, jev, onError }: { providers: ProviderStatus[]; jev: JevStatus | null; onError: (m: string) => void }) {
  const [checking, setChecking] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [jevDialog, setJevDialog] = useState(false);

  async function toggleJev() {
    if (!jev) return;
    setSwitching('jev');
    try {
      await api.saveJev({ enabled: !jev.enabled });
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSwitching(null);
    }
  }

  async function check() {
    setChecking(true);
    try {
      await api.refreshProviders();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setChecking(false);
    }
  }

  async function toggle(provider: ProviderStatus) {
    setSwitching(provider.id);
    try {
      await api.setProvider(provider.id, !provider.enabled);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSwitching(null);
    }
  }

  return (
    <div className="providers">
      <div className="agents-head">
        <p className="field-hint">Switched-on providers can be chosen wherever a model is picked. They use this machine's own logins.</p>
        <button className="secondary small" disabled={checking} onClick={check}><Icon name="rotate-ccw" size={14} /> {checking ? 'Checking…' : 'Check again'}</button>
      </div>
      <ul className="provider-list" aria-label="Providers">
        {providers.map((p) => (
          <li key={p.id} className="provider-row">
            <div className="provider-info">
              <span className="provider-name"><strong>{p.label}</strong><code>{p.command}</code></span>
              <span className={`provider-status small ${p.available ? 'is-available' : ''}`}>
                <span className="provider-dot" aria-hidden="true" />
                {p.available ? `Available · ${p.version ?? 'installed'}` : `Not installed: ${p.command} wasn't found`}
              </span>
              {p.path && <span className="muted small mono provider-path">{p.path}</span>}
              {p.available && p.versionCheck && <VersionNote provider={p} />}
            </div>
            <button className={`toggle ${p.enabled ? 'on' : ''}`} role="switch" aria-checked={p.enabled} aria-label={`Use ${p.label}`}
              title={!p.available && !p.enabled ? `${p.label} isn't installed` : p.enabled ? `Switch ${p.label} off` : `Switch ${p.label} on`}
              disabled={switching === p.id || (!p.available && !p.enabled)} onClick={() => toggle(p)}>
              <span className="knob" />
            </button>
          </li>
        ))}
        {jev && (
          <li className="provider-row" aria-label="Jev">
            <div className="provider-info">
              <span className="provider-name"><strong>Jev</strong><code>TypeSafe</code><span className="badge subtle">optional</span></span>
              <span className={`provider-status small ${jev.configured && jev.enabled ? 'is-available' : ''}`}>
                <span className="provider-dot" aria-hidden="true" />
                {!jev.configured ? 'Not added' : jev.enabled ? `On · ${jev.model}` : `Off · ${jev.model}`}
              </span>
              <span className="muted small">A fast decision model. With it, routine calls (does this need you, can planning be skipped, is a task too vague, is this a status question) skip a full LLM run. Everything works without it.</span>
            </div>
            {jev.configured ? <>
              <button className="ghost small" aria-label="Jev settings" title="Update or remove" onClick={() => setJevDialog(true)}><Icon name="settings" size={16} /></button>
              <button className={`toggle ${jev.enabled ? 'on' : ''}`} role="switch" aria-checked={jev.enabled} aria-label="Use Jev"
                title={jev.enabled ? 'Switch Jev off' : 'Switch Jev on'} disabled={switching === 'jev'} onClick={toggleJev}>
                <span className="knob" />
              </button>
            </> : <button className="secondary small" onClick={() => setJevDialog(true)}><Icon name="plus" size={14} /> Add</button>}
          </li>
        )}
      </ul>
      {jevDialog && jev && <JevDialog jev={jev} onClose={() => setJevDialog(false)} onError={onError} />}
    </div>
  );
}

/** Adds Jev with an API key, or updates or removes it. The key is checked with TypeSafe before it's saved. */
function JevDialog({ jev, onClose, onError }: { jev: JevStatus; onClose: () => void; onError: (m: string) => void }) {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(jev.configured ? jev.model : '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  async function save() {
    setBusy(true);
    setProblem('');
    try {
      await api.saveJev({ ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), model: model.trim() });
      onClose();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm('Remove Jev? The factory goes back to asking the LLM for every decision.')) return;
    try {
      await api.removeJev();
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed');
    }
  }

  return (
    <div className="modal-backdrop stacked" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-narrow" role="dialog" aria-modal="true" aria-labelledby="jev-title">
        <header className="modal-head">
          <h2 id="jev-title">{jev.configured ? 'Jev settings' : 'Add Jev'}</h2>
          <button className="ghost" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </header>
        <form className="modal-body settings-form jev-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <p className="field-hint">Jev is TypeSafe's decision model. Get an API key at <a href="https://typesafe.ai" target="_blank" rel="noreferrer">typesafe.ai</a>.</p>
          <div className="field">
            <label className="field-label" htmlFor="jev-key">API key</label>
            <input id="jev-key" className="mono" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoFocus
              placeholder={jev.configured ? 'Saved · type to replace' : 'Your TypeSafe API key'} aria-describedby="jev-key-hint" />
            <span className="field-hint" id="jev-key-hint">Checked with TypeSafe, then encrypted on this machine. It's never shown again.</span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="jev-model">Model</label>
            <input id="jev-model" className="mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="jev-latest" />
          </div>
          {problem && <p className="error-text" role="alert">{problem}</p>}
          <button type="submit" hidden />
        </form>
        <footer className="modal-foot">
          {jev.configured && <button className="danger ghost" disabled={busy} onClick={remove}>Remove</button>}
          <span className="spacer" />
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || (!jev.configured && !apiKey.trim())} onClick={save}>{busy ? 'Checking…' : 'Save'}</button>
        </footer>
      </div>
    </div>
  );
}
