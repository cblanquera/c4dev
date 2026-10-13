/**
 * The simulated assistant: a deterministic reading of everyday phrasing, so the
 * whole assistant flow works without tokens. It finds intents anywhere in a
 * sentence, ignores politeness and filler, recognises a project by its name or
 * repository folder, and reads "it" or "this card" as the card the
 * conversation was just about. Anything it can't place gets examples back.
 */
import { ACTIVE_STAGES, type AssistantMessage } from '../types.ts';
import type { AssistantAction, AssistantReply, ProjectDigest } from './driver.ts';

type DigestCard = ProjectDigest['cards'][number];

export interface AssistantInput {
  conversation: AssistantMessage[];
  projects: ProjectDigest[];
  cardDetails: (cardId: number) => string | null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Greetings, politeness and hedges that carry no intent. */
const FILLER = /^(?:(?:hey|hi|hello|ok(?:ay)?|so|yes|yeah|yep|great|thanks|thank you|cool|perfect|nice|looks good|lgtm|sounds good|alright|and|also|now)\b[,.!]?\s*)*(?:(?:please|kindly)\s+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:(?:help me|i(?:'d| would) like (?:you )?to|i want (?:you )?to|i need (?:you )?to|let's|lets|go ahead and|try to)\s+)?(?:please\s+)?/i;

/** Questions about something, as opposed to requests to do it. */
const QUESTION = /^(?:should|do|does|did|is|are|was|were|why|what|how|when|where|who|which|can i|could i|may i)\b/i;

const TASK_NOUN = '(?:card|task|ticket|story|issue|item|feature|todo)';
const CREATE_VERB = '(?:create|add|draft|make|write|log|file|open|start|put|set up)';
const CREATE_START = /^(?:create|add|draft|make|write|build|implement|log|file|new)\b/i;
const CREATE_ANYWHERE = new RegExp(`\\b${CREATE_VERB}\\b[^.?!]*?\\b${TASK_NOUN}s?\\b|\\bnew ${TASK_NOUN}\\b`, 'i');
/** Everything up to and including "create a new task to/for/that …". */
const CREATE_LEAD = new RegExp(`^.*?\\b${CREATE_VERB}\\s+(?:(?:a|an|the|another|one|some)\\s+)?(?:new\\s+)?${TASK_NOUN}s?\\b\\s*(?:(?:to|for|that|which|about|so|where|on)\\b\\s*)?(?:(?:will|would|should|can|could)\\s+)?`, 'i');

const CARD_REF = /(?:#|\b(?:card|task|ticket)\s+#?)(\d+)\b/i;
const PRONOUN = /\b(?:it|this|that|this card|that card|this one|that one|the card|the task)\b/i;

/** Card actions, most specific first. Each pattern runs on the message without filler. */
const ACTIONS: [AssistantAction['type'], RegExp][] = [
  ['request_changes', /\b(?:request(?:ing)? changes|send (?:\S+ ){0,3}back|needs? (?:some )?changes)\b/i],
  ['approve', /^(?:approve|accept|sign off on|ship)\b|\bapprove\b/i],
  ['resume', /^(?:resume|continue|unblock|retry|restart)\b|\bresume\b/i],
  ['merge', /^(?:merge|land)\b|\bmerge (?:it|this|that|#?\d+|card)\b/i],
  ['move_to_backlog', /^(?:move|queue|start|kick off|begin|go ahead with|run)\b|\b(?:to|into|in) the backlog\b|\bqueue (?:it|this|that|#?\d+)\b/i],
  ['message_coordinator', /^(?:tell|ask|message|reply to|let|inform|remind)\b|\b(?:tell|ask) the coordinator\b/i],
  ['update_card', /^(?:change|update|edit|rewrite|rename|revise)\b/i],
];

const ACTION_REPLY: Record<AssistantAction['type'], (id: number) => string> = {
  request_changes: (id) => `Sending #${id} back with your changes.`,
  approve: (id) => `Approving #${id}.`,
  resume: (id) => `Resuming #${id}.`,
  move_to_backlog: (id) => `Queuing #${id}.`,
  message_coordinator: (id) => `Passing that to the coordinator on #${id}.`,
  update_card: (id) => `Updating #${id}.`,
  merge: (id) => `Merging #${id}.`,
  pull: () => '',
  push: () => '',
  create_card: () => '',
};

/** Repeatedly strip filler, since phrases stack ("ok so can you please help me …"). */
function stripFiller(text: string): string {
  let current = text.trim();
  for (;;) {
    const next = current.replace(FILLER, '').trim();
    if (next === current) return current;
    current = next;
  }
}

/** Ways a user might name a project: its name, its repository folder, or its name without "project". */
function aliases(project: ProjectDigest): string[] {
  const short = project.name.replace(/\s+(?:project|app|repo)$/i, '');
  return [...new Set([project.name, project.repoName, short].filter((a) => a.trim().length >= 3))];
}

interface ProjectMatch {
  project: ProjectDigest;
  /** The words that named it, e.g. "in the demo-repo project", removed from task text. */
  phrase: string;
}

/** The project a message names. A name after "in/for/on" beats a bare mention; longer names beat shorter. */
function findProject(text: string, projects: ProjectDigest[]): ProjectMatch | null {
  let best: (ProjectMatch & { score: number }) | null = null;
  for (const project of projects) {
    for (const alias of aliases(project)) {
      const re = new RegExp(`(\\b(?:in|for|on|to|into|under|about)\\s+(?:the\\s+)?)?(?<![\\w-])${escape(alias)}(?![\\w-])(?:\\s+(?:project|board|repo(?:sitory)?)\\b)?`, 'i');
      const m = text.match(re);
      if (!m) continue;
      const score = (m[1] ? 1000 : 0) + alias.length;
      if (!best || score > best.score) best = { project, phrase: m[0], score };
    }
  }
  return best && { project: best.project, phrase: best.phrase };
}

/** "in the billing project" when no project is called billing. */
function unknownProject(text: string): string | null {
  return text.match(/\b(?:in|for|on|to|into|under)\s+(?:the\s+)?([\w.-]+)\s+(?:project|board|repo(?:sitory)?)\b/i)?.[1] ?? null;
}

/** The card the conversation was just about: the newest assistant message that showed one. */
function contextCard(conversation: AssistantMessage[]): number {
  for (const message of [...conversation].reverse()) {
    if (message.author === 'assistant' && message.cardIds.length) return message.cardIds[0];
  }
  return 0;
}

/** What follows the card reference: a message, note or new description. */
function afterReference(text: string): string {
  if (text.includes(':')) return text.slice(text.indexOf(':') + 1).trim();
  const ref = text.match(CARD_REF) ?? text.match(PRONOUN);
  const rest = ref ? text.slice((ref.index ?? 0) + ref[0].length) : '';
  return rest.replace(/^\s*(?:[,–—-]\s*)?(?:(?:that|to say|saying|with|about|to)\b\s*)?/i, '').trim();
}

/**
 * A task description from natural phrasing: "create a task to add calendar
 * settings such as timezone, language" becomes a titled card with bullets.
 * Text after a colon, or on later lines, is kept as written.
 */
export function taskFromRequest(message: string, phrase: string | null): string {
  const colon = message.indexOf(':');
  if (colon >= 0 && message.slice(colon + 1).trim()) return message.slice(colon + 1).trim();
  const [first, ...more] = message.split('\n');
  let text = phrase ? first.replace(phrase, ' ') : first;
  text = stripFiller(text.replace(/\s+/g, ' '));
  text = text.replace(CREATE_LEAD, '');
  text = stripFiller(text).replace(/\s+,/g, ',').replace(/[\s?.!,]+$/, '').trim();
  if (text.length < 3) return '';
  const title = capitalize(text);
  const list = title.match(/\b(?:such as|including|e\.g\.,?|for example|like)\s+(.+)$/i)?.[1];
  const items = list?.split(/\s*(?:,|;|\band\b|\bor\b|&)\s*/).map((i) => i.trim()).filter(Boolean) ?? [];
  const body = more.join('\n').trim();
  return [`# ${title}`, items.length >= 2 ? items.map((i) => `- ${i}`).join('\n') : '', body].filter(Boolean).join('\n\n');
}

function statusLine(project: ProjectDigest): string {
  const count = (pred: (c: DigestCard) => boolean) => project.cards.filter(pred).length;
  const parts = [
    [count((c) => ACTIVE_STAGES.includes(c.stage)), 'in flight'],
    [count((c) => c.stage === 'deliverables'), 'need you'],
    [count((c) => c.stage === 'backlog'), 'queued'],
    [count((c) => c.stage === 'complete'), 'done'],
  ].filter(([n]) => n).map(([n, label]) => `${n} ${label}`);
  const unmerged = count((c) => c.stage === 'complete' && (c.merge === 'unmerged' || c.merge === 'blocked'));
  if (unmerged) parts[parts.length - 1] += ` (${unmerged} not merged)`;
  return `- **${project.name}**${project.paused ? ' (paused)' : ''}: ${parts.join(' · ') || 'nothing in flight'}`;
}

/** A high-level status of every project, or one: no model needed. */
export function statusReport(projects: ProjectDigest[], projectId: number | null = null): { reply: string; cardIds: number[] } {
  const scope = projectId == null ? projects : projects.filter((p) => p.id === projectId);
  const waiting = scope.flatMap((p) => p.cards).filter((c) => c.stage === 'deliverables');
  return { reply: scope.map(statusLine).join('\n') || 'No projects yet.', cardIds: waiting.map((c) => c.id) };
}

const CARD_FILTERS: [RegExp, string, (c: DigestCard) => boolean][] = [
  [/\b(done|complete\w*|finished|shipped)\b/i, 'completed', (c) => c.stage === 'complete'],
  [/\b(in progress|in flight|working on|running|active|being built)\b/i, 'in flight', (c) => ACTIVE_STAGES.includes(c.stage)],
  [/\b(needs? me|waiting|deliverables?|blocked)\b/i, 'waiting on you', (c) => c.stage === 'deliverables'],
  [/\b(backlog|queued|up next)\b/i, 'queued', (c) => c.stage === 'backlog'],
  [/\b(icebox|drafts?|ideas?)\b/i, 'in the Icebox', (c) => c.stage === 'icebox'],
];

export function simulateAssistant(input: AssistantInput): AssistantReply {
  const message = [...input.conversation].reverse().find((m) => m.author === 'user')?.body.trim() ?? '';
  const text = stripFiller(message);
  const say = (reply: string, cardIds: number[] = [], actions: AssistantAction[] = []): AssistantReply => ({ reply, cardIds, actions });
  const asking = QUESTION.test(text);
  const named = findProject(text, input.projects);
  const scope = named ? [named.project] : input.projects;
  const waiting = scope.flatMap((p) => p.cards).filter((c) => c.stage === 'deliverables');
  const explicitCard = Number(text.match(CARD_REF)?.[1] ?? 0);
  const cardFor = () => explicitCard || (PRONOUN.test(text) ? contextCard(input.conversation) : 0);

  // New work always wins over card actions, so "create a task to approve invoices" never approves a card.
  const isCreate = !asking && !explicitCard && (CREATE_START.test(text) || CREATE_ANYWHERE.test(text));

  // Project sync: "pull the demo project", "push Shop to github".
  const sync = !asking && !explicitCard && text.match(/^(?:pull|push|sync)\b|\b(pull|push)\b[^.?!]*\b(?:remote|origin|github|gitlab|upstream)\b/i);
  if (sync) {
    const type = (sync[1] ?? sync[0]).toLowerCase() === 'push' ? 'push' : 'pull';
    const project = named?.project ?? (input.projects.length === 1 ? input.projects[0] : undefined);
    if (!project) return say(`Which project should I ${type}: ${input.projects.map((p) => p.name).join(', ')}?`);
    return say(`Queuing a ${type} for ${project.name}.`, [], [{ type, projectId: project.id, cardId: 0, body: '' }]);
  }

  // Card actions: "move #5 to the backlog", "ok approve it", "tell #5 that …".
  const action = asking || isCreate ? undefined : ACTIONS.find(([, re]) => re.test(text));
  if (action) {
    const [type] = action;
    const cardId = cardFor();
    if (!cardId) return say('Which card? Mention it like #12.');
    const body = type === 'move_to_backlog' ? '' : afterReference(text);
    return say(ACTION_REPLY[type](cardId), [cardId], [{ type, projectId: 0, cardId, body }]);
  }

  // New work: "in the demo-repo project can you help me create a task to add …".
  if (isCreate) {
    const missing = unknownProject(text);
    if (!named && missing) {
      return say(`I don't see a project called "${missing}". Which one: ${input.projects.map((p) => p.name).join(', ')}?`);
    }
    const project = named?.project ?? (input.projects.length === 1 ? input.projects[0] : undefined);
    if (!project) return say(`Which project should it go in: ${input.projects.map((p) => p.name).join(', ')}?`);
    const description = taskFromRequest(message.includes(':') ? message : text, named?.phrase ?? null);
    if (!description) return say(`What should the card in ${project.name} be about?`);
    return say(`Drafting that in ${project.name}.`, [], [{ type: 'create_card', projectId: project.id, cardId: 0, body: description }]);
  }

  if (/\b(suggest\w*|recommend\w*|what should (?:i|we)|advice|next steps?)\b/i.test(text)) {
    return waiting.length
      ? say(`Clear what's waiting on you first: ${waiting.map((c) => `#${c.id}`).join(', ')}.`, waiting.map((c) => c.id))
      : say('Nothing is waiting on you. Draft the next task, or queue an Icebox card that already has instructions.');
  }

  // Listing cards: "show me the last card done", "what's in the backlog?".
  const listing = /^(?:show|list|find|open|which|give me|pull up|display)\b/i.test(text) || /\bcards?\b|\btasks\b/i.test(text)
    || /\bwhat(?:'s| is| are)\s+(?:in|on)\b|\bwhat(?:'s| is| got)\s+(?:done|finished|completed|queued)\b/i.test(text);
  if (listing && !explicitCard && !/\b(needs? me|waiting on me)\b/i.test(text)) {
    const filter = CARD_FILTERS.find(([re]) => re.test(text));
    const found = scope.flatMap((p) => p.cards).filter(filter ? filter[2] : () => true)
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0) || b.id - a.id);
    const label = `${filter?.[1] ?? 'on the boards'}${named ? ` in ${named.project.name}` : ''}`;
    if (!found.length) return say(`No cards ${label}.`);
    if (/\b(last|latest|most recent|newest)\b/i.test(text)) return say(`The last card ${label}: #${found[0].id} ${found[0].title}.`, [found[0].id]);
    const shown = found.slice(0, 8);
    return say(`${plural(found.length, 'card')} ${label}${found.length > shown.length ? `; the ${shown.length} most recent` : ''}:`, shown.map((c) => c.id));
  }

  // One card: "#12?", "tell me more about it".
  const about = explicitCard || (/\b(tell me (?:more )?about|details?|more on|what about|what's happening with|status of|how is|how's)\b/i.test(text) && PRONOUN.test(text) ? contextCard(input.conversation) : 0);
  if (about) {
    const details = input.cardDetails(about);
    if (!details) return say(`I can't find #${about}.`);
    const [title, project, stage, status] = details.split('\n');
    return say(`${title} (${project.replace('Project: ', '')}): ${stage.replace('Stage: ', '')}. ${status}.`, [about]);
  }

  if (/\b(needs? me|needs? my|waiting on me|need from me|anything for me|blocked on me|my (?:input|attention|approval))\b/i.test(text)) {
    return waiting.length
      ? say(`${plural(waiting.length, 'card needs', 'cards need')} you: ${waiting.map((c) => `#${c.id} (${c.waitingFor})`).join(', ')}.`, waiting.map((c) => c.id))
      : say('Nothing needs you right now.');
  }

  if (named || /\b(status|update|progress|how are|how's|going|overview|summar\w*|report|catch me up|what's new|anything new|where are we)\b/i.test(text)) {
    return say(scope.map(statusLine).join('\n'), waiting.map((c) => c.id));
  }

  const example = input.projects[0]?.name ?? 'a project';
  return say([
    "I didn't catch that. I'm the simulated assistant, so I follow common phrasings, for example:",
    `- "What's the status?" or "What needs me?"`,
    `- "Create a task in ${example} to add a dark mode toggle"`,
    '- "Move #12 to the backlog", "Approve #12", "Tell #12 the key is ready"',
    '- "Show me the cards in progress"',
    'Switch the assistant to Claude in Settings for free-form conversation.',
  ].join('\n'));
}
