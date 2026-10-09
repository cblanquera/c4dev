/**
 * The skills library in Settings. Add skills opens a dialog for a local folder
 * (every SKILL.md inside it, with the files beside it), a GitHub repository or
 * a skills.sh entry; agents then choose from the library.
 */
import { Icon } from './Icon.tsx';
import { useRef, useState, type KeyboardEvent } from 'react';
import { api, type SkillImport } from '../api.ts';
import type { AgentProfile, Skill } from '../../../server/types.ts';

const IGNORED = /(^|\/)(\.git|node_modules)(\/|$)/;
const isSkillFile = (path: string) => /^skills?\.md$/i.test(path.split('/').pop() ?? '');
const dirname = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Base64 without blowing the call stack on large files. */
async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Groups a picked folder into skill folders: each SKILL.md's folder with the
 * files under it, leaving out folders that hold a skill of their own.
 */
export async function skillsFromFolder(files: File[]) {
  const all = files.map((file) => ({ file, path: file.webkitRelativePath || file.name })).filter((f) => !IGNORED.test(f.path));
  const roots = all.filter((f) => isSkillFile(f.path)).map((f) => dirname(f.path));
  const skills = await Promise.all(roots.map(async (root) => {
    const prefix = root ? `${root}/` : '';
    const mine = all.filter((f) => f.path.startsWith(prefix) && !roots.some((other) => other !== root && other.startsWith(prefix) && f.path.startsWith(`${other}/`)));
    return { where: root, files: await Promise.all(mine.map(async (f) => ({ path: f.path.slice(prefix.length), data: await base64(f.file) }))) };
  }));
  return { source: all[0]?.path.split('/')[0] ?? 'folder', skills };
}

function summary(result: SkillImport): string {
  const parts = [
    result.added.length ? `Added ${result.added.join(', ')}` : '',
    result.updated.length ? `Updated ${result.updated.join(', ')}` : '',
    result.skipped.length ? `Skipped ${result.skipped.map((s) => `${s.where} (${s.reason})`).join('; ')}` : '',
  ].filter(Boolean);
  return parts.join('. ') || 'Nothing imported.';
}

type Source = 'local' | 'github' | 'skills.sh';
const SOURCES: { id: Source; label: string }[] = [
  { id: 'local', label: 'Local' },
  { id: 'github', label: 'GitHub' },
  { id: 'skills.sh', label: 'Skills.sh' },
];

/** Add skills from a local folder, a GitHub repository or skills.sh. */
function AddSkillsDialog({ onClose, onError }: { onClose: () => void; onError: (message: string) => void }) {
  const [tab, setTab] = useState<Source>('local');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [github, setGithub] = useState('');
  const [skillsSh, setSkillsSh] = useState('');
  const folder = useRef<HTMLInputElement>(null);

  async function run(fn: () => Promise<SkillImport>) {
    setBusy(true);
    setResult('');
    try {
      setResult(summary(await fn()));
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  async function importFolder(list: FileList | null) {
    if (!list?.length) return;
    const picked = await skillsFromFolder([...list]);
    if (!picked.skills.length) return onError('No SKILL.md files in that folder');
    await run(() => api.importSkillFolder(picked));
  }

  function onTabKey(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = SOURCES.findIndex((x) => x.id === tab);
    const next = SOURCES[(i + (e.key === 'ArrowRight' ? 1 : SOURCES.length - 1)) % SOURCES.length].id;
    setTab(next);
    setResult('');
    document.getElementById(`skills-tab-${next}`)?.focus();
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-narrow" role="dialog" aria-modal="true" aria-labelledby="add-skills-title">
        <header className="modal-head">
          <h2 id="add-skills-title">Add skills</h2>
          <button className="ghost" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </header>
        <div className="tabs" role="tablist" aria-label="Skill sources" onKeyDown={onTabKey}>
          {SOURCES.map((x) => (
            <button key={x.id} id={`skills-tab-${x.id}`} role="tab" aria-selected={tab === x.id} aria-controls="skills-source-panel" tabIndex={tab === x.id ? 0 : -1}
              className={tab === x.id ? 'active' : ''} onClick={() => { setTab(x.id); setResult(''); }}>{x.label}</button>
          ))}
        </div>
        <div className="modal-body add-skills" id="skills-source-panel" role="tabpanel" aria-labelledby={`skills-tab-${tab}`}>
          {tab === 'local' && (
            <div className="skill-source">
              <p className="field-hint">Choose a folder: every SKILL.md inside it, at any depth, becomes a skill with the files beside it. .git and node_modules are skipped.</p>
              <div>
                <button className="secondary" disabled={busy} onClick={() => folder.current?.click()}><Icon name="plus" size={14} /> {busy ? 'Importing…' : 'Choose folder'}</button>
                <input ref={folder} type="file" multiple hidden aria-label="Skills folder" {...{ webkitdirectory: '', directory: '' }}
                  onChange={(e) => { void importFolder(e.target.files); e.target.value = ''; }} />
              </div>
            </div>
          )}
          {tab === 'github' && (
            <form className="skill-source" onSubmit={(e) => { e.preventDefault(); if (github.trim()) void run(() => api.importSkillGithub(github)); }}>
              <label className="field-label" htmlFor="skills-github">Repository link</label>
              <div className="skill-source-row">
                <input id="skills-github" aria-describedby="skills-github-hint" className="mono" value={github} placeholder="https://github.com/owner/repo" onChange={(e) => setGithub(e.target.value)} autoFocus />
                <button className="primary" type="submit" disabled={busy || !github.trim()}>{busy ? 'Importing…' : 'Import'}</button>
              </div>
              <span className="field-hint" id="skills-github-hint">A single-skill repository, or one with a skills folder. Link to a folder with /tree/&lt;branch&gt;/&lt;path&gt;. Private repositories use this machine's git login.</span>
            </form>
          )}
          {tab === 'skills.sh' && (
            <form className="skill-source" onSubmit={(e) => { e.preventDefault(); if (skillsSh.trim()) void run(() => api.importSkillsSh(skillsSh)); }}>
              <label className="field-label" htmlFor="skills-sh">Skill link</label>
              <div className="skill-source-row">
                <input id="skills-sh" aria-describedby="skills-sh-hint" className="mono" value={skillsSh} placeholder="https://skills.sh/owner/repo/skill" onChange={(e) => setSkillsSh(e.target.value)} autoFocus />
                <button className="primary" type="submit" disabled={busy || !skillsSh.trim()}>{busy ? 'Importing…' : 'Import'}</button>
              </div>
              <span className="field-hint" id="skills-sh-hint">Find a skill on <a href="https://skills.sh" target="_blank" rel="noreferrer">skills.sh</a> and paste its link, or owner/repo/skill. GitHub-hosted entries only.</span>
            </form>
          )}
          {result && <p className="skill-result small" role="status">{result}</p>}
        </div>
        <footer className="modal-foot">
          <button className="secondary" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  );
}

interface Props {
  skills: Map<number, Skill>;
  profiles: AgentProfile[];
  onError: (message: string) => void;
}

export function SkillsLibrary({ skills, profiles, onError }: Props) {
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<{ id: number; content: string; files: string[] } | null>(null);
  const library = [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  const usedBy = (id: number) => profiles.filter((p) => !p.archived && p.skillIds.includes(id)).map((p) => p.name);

  async function view(skill: Skill) {
    if (open?.id === skill.id) return setOpen(null);
    try {
      const { content, files } = await api.skill(skill.id);
      setOpen({ id: skill.id, content, files });
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed');
    }
  }

  return (
    <div className="skills-library">
      <div className="agents-head">
        <p className="field-hint">Skills in the library can be attached to agents. {library.length} skill{library.length === 1 ? '' : 's'}.</p>
        <button className="primary small" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add skills</button>
      </div>
      {!library.length && <p className="muted small">No skills yet. Add some, then attach them to agents.</p>}
      <ul className="skill-list library" aria-label="Skills library">
        {library.map((skill) => {
          const users = usedBy(skill.id);
          return (
            <li key={skill.id}>
              <div className="skill-entry">
                <strong className="mono">{skill.name}</strong>
                <span className="muted small">{skill.description || 'No description'}</span>
                <span className="muted small">{skill.source || 'Upload'} · {skill.fileCount} file{skill.fileCount === 1 ? '' : 's'} · {users.length ? `Used by ${users.join(', ')}` : 'Not used by any agent'}</span>
                {open?.id === skill.id && (
                  <div className="skill-preview">
                    <span className="muted small">{open.files.join(' · ')}</span>
                    <pre className="log-pre">{open.content}</pre>
                  </div>
                )}
              </div>
              <button className="ghost small" aria-expanded={open?.id === skill.id} onClick={() => view(skill)}>{open?.id === skill.id ? 'Hide' : 'View'}</button>
              <button className="ghost small" aria-label={`Delete skill ${skill.name}`}
                onClick={() => confirm(`Delete "${skill.name}" from the library?${users.length ? ` It's detached from ${users.join(', ')}.` : ''}`)
                  && api.removeSkill(skill.id).catch((err) => onError(err instanceof Error ? err.message : 'Failed'))}><Icon name="x" size={14} /></button>
            </li>
          );
        })}
      </ul>
      {adding && <AddSkillsDialog onClose={() => setAdding(false)} onError={onError} />}
    </div>
  );
}
