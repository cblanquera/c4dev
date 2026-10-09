/**
 * Filling the skills library from GitHub and skills.sh. A repository is cloned
 * shallowly with this machine's git credentials (never prompting), then
 * scanned: a SKILL.md at its root makes it a single-skill repository;
 * otherwise its `skills/` folder (or, without one, the whole repository) is
 * searched for SKILL.md files. Folder imports are grouped in the browser and
 * arrive as files.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, shellQuote } from './shell.ts';
import { HttpError } from './errors.ts';
import { importSkills, isSkillFile, parseSkill, skillSlug, type ImportResult, type SkillFile } from './profiles.ts';

const IGNORED = new Set(['.git', 'node_modules']);
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
const CLONE_TIMEOUT_MS = 120_000;
const NAME = /^[\w.-]+$/;

export interface GithubTarget {
  owner: string;
  repo: string;
  /** Branch or tag from a /tree/<ref>/ URL. */
  ref: string | null;
  /** Folder inside the repository from a /tree/<ref>/<path> URL. */
  subpath: string;
}

/** https://github.com/owner/repo[.git][/tree/<ref>[/<path>]] */
export function parseGithubUrl(url: string): GithubTarget {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new HttpError(400, 'Paste a GitHub repository link, e.g. https://github.com/owner/repo');
  }
  if (parsed.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(parsed.hostname)) {
    throw new HttpError(400, 'Only https://github.com repository links can be imported');
  }
  const [owner, rawRepo, tree, ref, ...rest] = parsed.pathname.split('/').filter(Boolean);
  const repo = rawRepo?.replace(/\.git$/, '');
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) throw new HttpError(400, 'That link has no owner/repository');
  if (tree && tree !== 'tree') throw new HttpError(400, 'Link to the repository, or to a folder with /tree/<branch>/<path>');
  if (ref && !/^[\w./-]+$/.test(ref)) throw new HttpError(400, 'Unsupported branch name');
  const subpath = rest.join('/');
  if (subpath.split('/').includes('..')) throw new HttpError(400, 'Unsupported path');
  return { owner, repo, ref: ref ?? null, subpath };
}

export interface SkillsShTarget {
  owner: string;
  repo: string;
  /** A single skill, or null for every skill in the repository. */
  skill: string | null;
}

/** https://skills.sh/owner/repo[/skill], or owner/repo[/skill] as `npx skills add` takes it. */
export function parseSkillsShRef(ref: string): SkillsShTarget {
  const text = ref.trim().replace(/^https?:\/\/(www\.)?skills\.sh\//, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  const parts = text.split('/').filter(Boolean);
  if (parts.length < 2 || parts.length > 3 || !parts.every((p) => NAME.test(p))) {
    throw new HttpError(400, 'Paste a skills.sh link, e.g. https://skills.sh/owner/repo/skill, or owner/repo/skill');
  }
  if (parts[0] === 'site' || parts[0].includes('.')) {
    throw new HttpError(400, 'Only GitHub-hosted skills.sh entries can be imported; this one is published from a website');
  }
  return { owner: parts[0], repo: parts[1], skill: parts[2] ?? null };
}

/** Every file under `dir`, relative to it, skipping .git and node_modules. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name) || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full).map((f) => `${entry.name}/${f}`));
    else if (entry.isFile()) out.push(entry.name);
  }
  return out;
}

/** Skill folders under `root`: each SKILL.md's folder with its files, minus nested skills' folders. */
export function collectSkills(root: string): { where: string; files: SkillFile[] }[] {
  const files = walk(root);
  const roots = files.filter((f) => isSkillFile(path.posix.basename(f))).map((f) => path.posix.dirname(f));
  return roots.map((dir) => {
    const prefix = dir === '.' ? '' : `${dir}/`;
    const mine = files.filter((f) => f.startsWith(prefix)
      && !roots.some((other) => other !== dir && (other === '.' ? false : other.startsWith(prefix) && f.startsWith(`${other}/`))));
    return { where: dir === '.' ? '' : dir, files: mine.map((f) => ({ path: f.slice(prefix.length), data: fs.readFileSync(path.join(root, f)) })) };
  });
}

/**
 * Clones a repository and imports its skills. `skill` keeps only the skill
 * whose folder or frontmatter name matches (skills.sh entries name one).
 */
export async function importFromGit(cloneUrl: string, opts: { ref?: string | null; subpath?: string; skill?: string | null; source: string; signal?: AbortSignal }): Promise<ImportResult> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-skills-'));
  try {
    const target = path.join(tmp, 'repo');
    const branch = opts.ref ? `--branch ${shellQuote(opts.ref)} ` : '';
    const res = await run(`git clone --quiet --depth 1 ${branch}${shellQuote(cloneUrl)} ${shellQuote(target)}`,
      { cwd: tmp, env: NO_PROMPT, timeoutMs: CLONE_TIMEOUT_MS, signal: opts.signal });
    if (res.code !== 0) {
      throw new HttpError(400, `Couldn't clone the repository. Check the link, and this machine's git credentials for private repositories.\n${res.output.trim().split('\n').slice(-3).join('\n')}`);
    }
    const root = path.join(target, opts.subpath ?? '');
    if (!root.startsWith(target) || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new HttpError(400, `No folder ${opts.subpath} in the repository`);
    const single = fs.readdirSync(root).some(isSkillFile);
    const skillsFolder = path.join(root, 'skills');
    let bundles = single ? collectSkills(root).filter((b) => b.where === '') : collectSkills(fs.existsSync(skillsFolder) ? skillsFolder : root);
    if (opts.skill) {
      const wanted = skillSlug(opts.skill);
      bundles = bundles.filter((b) => skillSlug(path.posix.basename(b.where || opts.skill!)) === wanted
        || skillSlug(parseSkill(b.files.find((f) => isSkillFile(f.path))?.data.toString('utf8') ?? '').name) === wanted);
      if (!bundles.length) throw new HttpError(404, `No skill called "${opts.skill}" in that repository`);
    }
    if (!bundles.length) throw new HttpError(404, 'No SKILL.md found in that repository');
    return importSkills(bundles, opts.source);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function importFromGithub(url: string, signal?: AbortSignal): Promise<ImportResult> {
  const t = parseGithubUrl(url);
  return importFromGit(`https://github.com/${t.owner}/${t.repo}.git`, {
    ref: t.ref, subpath: t.subpath, signal, source: `GitHub: ${t.owner}/${t.repo}${t.subpath ? `/${t.subpath}` : ''}`,
  });
}

/** skills.sh lists GitHub repositories, so an entry is imported from its repository. */
export function importFromSkillsSh(ref: string, signal?: AbortSignal): Promise<ImportResult> {
  const t = parseSkillsShRef(ref);
  return importFromGit(`https://github.com/${t.owner}/${t.repo}.git`, {
    skill: t.skill, signal, source: `skills.sh: ${t.owner}/${t.repo}${t.skill ? `/${t.skill}` : ''}`,
  });
}
