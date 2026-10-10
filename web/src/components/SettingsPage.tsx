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
import { goHome } from '../nav.ts';
import type { AgentProfile, Project, ProviderStatus, Skill, UsageTotals } from '../../../server/types.ts';

export const SETTINGS_SECTIONS = [
  { id: 'agents', label: 'Agents' },
  { id: 'skills', label: 'Skills' },
  { id: 'providers', label: 'Providers' },
  { id: 'data', label: 'Data' },
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id'];

interface Props {
  section: SettingsSection;
  profiles: AgentProfile[];
  skills: Map<number, Skill>;
  projects: Project[];
  usage: Record<number, UsageTotals>;
  providers: ProviderStatus[];
  onError: (m: string) => void;
}

export function SettingsPage({ section, profiles, skills, projects, usage, providers, onError }: Props) {
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
        {section === 'agents' && <AgentsSection profiles={profiles} skills={skills} projects={projects} usage={usage} providers={providers} onError={onError} />}
        {section === 'skills' && <SkillsLibrary skills={skills} profiles={profiles} onError={onError} />}
        {section === 'providers' && <ProvidersSection providers={providers} onError={onError} />}
        {section === 'data' && <DataSection onError={onError} />}
      </section>
    </main>
  );
}

/** The agent CLIs on this machine: installed or not, and switched on or off. */
function ProvidersSection({ providers, onError }: { providers: ProviderStatus[]; onError: (m: string) => void }) {
  const [checking, setChecking] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);

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
            </div>
            <button className={`toggle ${p.enabled ? 'on' : ''}`} role="switch" aria-checked={p.enabled} aria-label={`Use ${p.label}`}
              title={!p.available && !p.enabled ? `${p.label} isn't installed` : p.enabled ? `Switch ${p.label} off` : `Switch ${p.label} on`}
              disabled={switching === p.id || (!p.available && !p.enabled)} onClick={() => toggle(p)}>
              <span className="knob" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
