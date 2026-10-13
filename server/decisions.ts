/**
 * Routine decisions Jev can make when it's added, each saving a full LLM run.
 * Every function returns null ("ask the LLM as before") unless Jev is added,
 * switched on and confident; the factory never depends on it. Each question is
 * atomic, as TypeSafe recommends, and code combines the answers.
 *
 * The wordings and thresholds were calibrated against the real API: Jev
 * answers short, plain questions far more decisively than long, qualified
 * ones ("Is the user asking for a status update?" separates status messages
 * at 0.85–0.98 from everything else at ≤ 0.11; a longer "only … nothing
 * else" version blurred them to 0.3–0.8). Change them with care.
 */
import { ask, choice, clip, noul, score, type JevCharge } from './jev.ts';
import { subtaskDigest } from './prompts.ts';
import type { ProjectDigest } from './agents/driver.ts';
import type { Card, Subtask } from './types.ts';

/** Below this, a "yes" probability counts as a confident no. */
const CONFIDENT_NO = 0.15;
/** At or above this, a "yes" probability or a choice counts as confident. */
const CONFIDENT_YES = 0.9;
/** A status question is recognised at or above this (calibrated: status ≥ 0.85, others ≤ 0.11). */
const STATUS_YES = 0.8;
/** The named project is trusted at or above this; otherwise every project is reported, which is harmless. */
const PROJECT_MATCH = 0.5;
/** An expected specificity below this (on the 0–3 rubric) is too vague: "Fix it" 0.03, "dark mode" 0.34; clear tasks score 2+. */
const TOO_VAGUE = 0.6;

/** The approval rules from `approvalPrompt`, one yes/no each. */
const APPROVAL_CRITERIA = {
  credentials: 'Does the work need credentials, API keys, tokens or logins that were stubbed, mocked or left for a human to provide?',
  sensitive: 'Does the work touch payments, security, authentication, data deletion or database migrations?',
  // Concrete wordings: vaguer ones ("assumptions a human should confirm") scored ~0.45 even for a typo fix.
  open_ux: 'Did the work make a visible product decision the task description did not specify, such as new wording, layout or behaviour the user never asked for?',
  assumptions: 'Do the work notes mention a guess, an open question, or something left for a human to decide?',
  review_requested: 'Does the task description explicitly ask for a review, an approval or a sign-off?',
};

/**
 * Whether finished work can complete without a human. Only a confident "no
 * human needed" on every criterion skips the LLM; anything else goes to it.
 */
export async function approvalByJev(card: Card, subtasks: Subtask[], charge: JevCharge, signal?: AbortSignal): Promise<{ reason: string } | null> {
  const answers = await ask(
    {
      task_description: clip(card.description, 4000),
      agent_instructions: clip(card.instructions, 6000),
      work_done: clip(subtaskDigest(subtasks), 6000),
      secrets_provided: card.secretNames,
    },
    Object.fromEntries(Object.entries(APPROVAL_CRITERIA).map(([name, question]) => [name, noul(question)])),
    charge, signal,
  );
  if (!answers) return null;
  const odds = Object.keys(APPROVAL_CRITERIA).map((name) => [name, answers[name].type === 'noul' ? answers[name].noul : 1] as const);
  const [top, p] = odds.reduce((a, b) => (b[1] > a[1] ? b : a));
  if (p >= CONFIDENT_NO) return null;
  return { reason: `Jev found nothing that needs a human (highest: ${top.replace('_', ' ')} at ${Math.round(p * 100)}%).` };
}

/** Whether one worker can do the card as a single change, so the planning run can be skipped. */
export async function singleChangeByJev(card: Card, charge: JevCharge, signal?: AbortSignal): Promise<boolean> {
  const answers = await ask(
    { task_description: clip(card.description, 4000), agent_instructions: clip(card.instructions, 8000) },
    // Calibrated: a typo fix 0.98, a button rename 0.96, a CSV export 0.82, user accounts 0.24, a vague task 0.48.
    { single_change: noul('Is this a small change one developer can make in one go?') },
    charge, signal,
  );
  return !!answers && answers.single_change.type === 'noul' && answers.single_change.noul >= CONFIDENT_YES;
}

/** A reason to ask for more detail before writing instructions, or null to go ahead. */
export async function vagueByJev(description: string, charge: JevCharge, signal?: AbortSignal): Promise<string | null> {
  const answers = await ask(
    { task_description: clip(description, 6000) },
    { specificity: score('How clearly does this describe what "done" looks like?', [
      'No idea what is wanted: a title or a few words, no outcome.',
      'A goal, but the expected behaviour is unclear.',
      'Clear goal and mostly clear behaviour; minor details open.',
      'Clear outcome and behaviour; ready to implement.',
    ]) },
    charge, signal,
  );
  const answer = answers?.specificity;
  if (!answer || answer.type !== 'score' || answer.score >= TOO_VAGUE) return null;
  return 'This description is too brief to write useful instructions from. Add what "done" looks like: the behaviour you expect, where it lives, and anything it must not change.';
}

/** A status question the code can answer from the boards: which project, or null for all. */
export async function statusIntentByJev(message: string, projects: ProjectDigest[], charge: JevCharge, signal?: AbortSignal): Promise<{ projectId: number | null } | null> {
  const labels = Object.fromEntries(projects.map((p) => [`p${p.id}`, `${p.name} (folder ${p.repoName})`]));
  const answers = await ask(
    { message: clip(message, 2000) },
    {
      status: noul('Is the user asking for a status update?'),
      project: choice('Which project is the message about?', { all: 'All projects, or none named.', ...labels }),
    },
    charge, signal,
  );
  if (!answers || answers.status.type !== 'noul' || answers.status.noul < STATUS_YES) return null;
  const project = answers.project.type === 'choice' && answers.project.confidence >= PROJECT_MATCH ? answers.project.choice : 'all';
  return { projectId: project === 'all' ? null : Number(project.slice(1)) || null };
}
