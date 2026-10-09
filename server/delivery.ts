/** Review notes for older cards and a grounded fallback for simulated runs. */
import type { Card, Comment, LogEntry, Settings, Subtask } from './types.ts';

/** Summarise recorded results without inventing a preview or test account. */
export function recordedDelivery(card: Card, subtasks: Subtask[], logs: LogEntry[], cfg: Settings): string {
  const files = [...new Set(subtasks.flatMap((s) => s.files.map((f) => f.path)))];
  const passed = logs.filter((l) => /^(Tests passed|Acceptance tests passed|Coverage \d)/.test(l.text));
  return [
    '### What changed',
    subtasks.filter((s) => s.status === 'done' && s.kind !== 'acceptance').map((s) => `- ${s.summary || s.title}`).join('\n') || 'No completed work recorded yet.',
    '### How to review',
    card.branch ? `- Changes are on branch \`${card.branch}\` in \`${cfg.repoPath}\`.` : '- No result branch recorded yet.',
    files.length ? `- Changed files: ${files.map((file) => `\`${file}\``).join(', ')}.` : '',
    '- Preview URL: no preview URL recorded.',
    '- Test login: no test account recorded. Provide any required credentials through Secret.',
    '### Verification',
    passed.length ? [...new Set(passed.map((l) => l.text))].map((text) => `- ${text}`).join('\n') : 'No passing verification results recorded yet.',
    '### Things to be aware of',
    subtasks.some((s) => s.files.some((f) => f.path.startsWith('factory-sim/'))) ? '- The simulated driver writes demonstration notes and acceptance outlines; it does not implement the requested application.' : '- Review the recorded changes and confirm any deployment or access details before testing.',
    card.loops ? `- Verification sent the work back for ${card.loops} rework round(s). Review the final result.` : '',
    '- Branch results are not a deployment. A preview URL and test access must be supplied if needed.',
  ].filter(Boolean).join('\n\n');
}

/** The latest persisted handoff supersedes the fallback after rework. */
export function deliveryNotes(card: Card, subtasks: Subtask[], logs: LogEntry[], comments: Comment[], cfg: Settings): string {
  return [...comments].reverse().find((c) => c.kind === 'handoff')?.body
    ?? (['complete', 'deliverables'].includes(card.stage) ? recordedDelivery(card, subtasks, logs, cfg) : '');
}
