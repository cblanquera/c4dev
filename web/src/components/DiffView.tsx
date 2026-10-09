/** Unified diff, split per file, collapsible. */
import { Icon } from './Icon.tsx';
import { useMemo, useState } from 'react';

interface FileDiff {
  path: string;
  lines: string[];
  added: number;
  removed: number;
}

export function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/ b\/(.+)$/);
      current = { path: m?.[1] ?? line, lines: [], added: 0, removed: 0 };
      files.push(current);
      continue;
    }
    if (!current || /^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to))/.test(line)) continue;
    current.lines.push(line);
    if (line.startsWith('+')) current.added++;
    else if (line.startsWith('-')) current.removed++;
  }
  return files;
}

export function DiffView({ diff }: { diff: string }) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(files.length > 6 ? files.map((f) => f.path) : []));
  if (!files.length) return <p className="muted small">No changes.</p>;
  return (
    <div className="diff">
      {files.map((f) => {
        const isCollapsed = collapsed.has(f.path);
        return (
          <div key={f.path} className="diff-file">
            <button className="diff-head" aria-expanded={!isCollapsed} onClick={() => setCollapsed((s) => {
              const next = new Set(s);
              if (next.has(f.path)) next.delete(f.path);
              else next.add(f.path);
              return next;
            })}>
              <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={14} />
              <span className="mono path">{f.path}</span>
              <span className="add">+{f.added}</span>
              <span className="del">−{f.removed}</span>
            </button>
            {!isCollapsed && (
              <pre className="diff-body">
                {f.lines.map((l, i) => (
                  <div key={i} className={l.startsWith('+') ? 'l-add' : l.startsWith('-') ? 'l-del' : l.startsWith('@@') ? 'l-hunk' : ''}>{l || ' '}</div>
                ))}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
