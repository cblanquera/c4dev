/**
 * Shared domain types for the software factory.
 * The web client imports these too, so keep this file free of Node imports.
 */

export const STAGES = [
  'icebox',
  'backlog',
  'in_progress',
  'verification',
  'acceptance',
  'deliverables',
  'complete',
] as const;

export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  icebox: 'Icebox',
  backlog: 'Backlog',
  in_progress: 'In Progress',
  verification: 'Verification',
  acceptance: 'Acceptance',
  deliverables: 'Deliverables',
  complete: 'Complete',
};

/** Stages where the coordinator owns the card and agents may be running. */
export const ACTIVE_STAGES: readonly Stage[] = ['in_progress', 'verification', 'acceptance'];

/** Why a card is sitting in Deliverables. */
export type DeliverableKind = 'approval' | 'input' | 'blocked';

/**
 * Whether a completed card's branch has reached the base branch: merged,
 * unmerged (the branch was kept), or blocked (an automatic merge was refused).
 */
export type MergeState = 'merged' | 'unmerged' | 'blocked';

/**
 * task: written by the user. merge, pull and push: integration work the
 * factory queues itself, starting in the Backlog.
 */
export const CARD_KINDS = ['task', 'merge', 'pull', 'push'] as const;
export type CardKind = (typeof CARD_KINDS)[number];
export const CARD_KIND_LABELS: Record<CardKind, string> = { task: 'Task', merge: 'Merge', pull: 'Pull', push: 'Push' };

/**
 * A profile's role: what it does. Ids are stable storage keys; `developer` is
 * shown as Worker and `senior` as Architect.
 */
export const AGENT_JOBS = ['coordinator', 'developer', 'auditor', 'senior', 'assistant'] as const;
export type AgentJob = (typeof AGENT_JOBS)[number];
export const JOB_LABELS: Record<AgentJob, string> = {
  coordinator: 'Coordinator', developer: 'Worker', auditor: 'Auditor', senior: 'Architect', assistant: 'Chief of Staff',
};

/** A named agent the user can recognise: a picture, a brief, a model and skills. */
export interface AgentProfile {
  id: number;
  name: string;
  job: AgentJob;
  /** Shown beside the name, e.g. "Frontend Developer"; empty shows the role. */
  title: string;
  /** Markdown added to the instructions of every run this profile does. */
  context: string;
  imageUrl: string | null;
  /** What runs this profile: the simulation or a provider. */
  provider: DriverName;
  /** The model on that provider; empty uses the provider's default. */
  model: string;
  skillIds: number[];
  /** MCP servers from the contexts library this agent's runs can use. */
  contextIds: number[];
  /** Monthly limits on this agent's runs; 0 means no limit. */
  budgetUsd: number;
  budgetTokens: number;
  createdAt: number;
  /** Deleted profiles are archived, so recorded activity keeps their name and picture. */
  archived: boolean;
}

/**
 * A context: an MCP server agents can be given, started from a command or
 * reached at a URL, or a local folder of Markdown knowledge (an AGENTS.md or
 * CONTEXT.md entry document and the files it links to). Environment and
 * header values are secrets: they're encrypted at rest and never sent to
 * clients, only their names.
 */
export interface Context {
  id: number;
  /** Letters, digits, - and _; agents see its tools as mcp__<name>__<tool>. */
  name: string;
  description: string;
  transport: 'stdio' | 'http' | 'folder';
  /** folder: where the knowledge lives (`~` is the home folder). */
  folder: string;
  /** stdio: the command and its arguments. */
  command: string;
  args: string[];
  /** stdio: where the command starts (`~` is the home folder); empty is the factory's folder. */
  cwd: string;
  /** stdio: variables passed through from the factory's own environment, by name. */
  envPassthrough: string[];
  /** http: a streamable HTTP endpoint. */
  url: string;
  /** http: a variable in the factory's environment holding a bearer token for the Authorization header. */
  bearerTokenEnv: string;
  /** http: headers whose values come from the factory's environment: header → variable. */
  envHeaders: Record<string, string>;
  envNames: string[];
  headerNames: string[];
  /** Its tools only read, so read-only roles (planner, architect, assistant) may use it too. */
  readOnly: boolean;
  /** Switched off, no agent starts it, though it stays attached. */
  enabled: boolean;
  createdAt: number;
}

/** What the assistant's Status button asks; the server answers it from the boards, without a model. */
export const STATUS_QUESTION = 'What is the status of all projects?';

/**
 * Jev, TypeSafe's decision model: optional. When it's added and switched on,
 * routine decisions (does this need a human, can planning be skipped, is this
 * too vague, is this a status question) are asked of it before a full LLM run;
 * without it, or when it's unsure, the factory works exactly as before.
 */
export interface JevStatus {
  /** An API key is saved (never sent to clients). */
  configured: boolean;
  enabled: boolean;
  model: string;
}

/** Caps on every agent run, factory-wide. A run that hits one stops and counts as a failed attempt. */
export interface RunLimits {
  /** Tool calls or model turns. */
  maxTurns: number;
  runMinutes: number;
}

/** Usage per local calendar day and per model, for the Usage sections. */
export interface UsageReport {
  /** Oldest first, one entry per day in the range (days without runs are zero). `day` is YYYY-MM-DD. */
  days: (UsageTotals & { day: string })[];
  /** Most expensive first, then most tokens. */
  models: (UsageTotals & { model: string })[];
  total: UsageTotals;
}

/** Usage since the start of this calendar month (server time), for budgets. */
export interface MonthUsage {
  since: number;
  byProject: Record<number, UsageTotals>;
  byProfile: Record<number, UsageTotals>;
}

/** A skill in the library: a folder with a SKILL.md and any files it uses. Content is fetched separately. */
export interface Skill {
  id: number;
  name: string;
  description: string;
  /** Where it came from, e.g. "GitHub: owner/repo" or "Folder: my-skills". */
  source: string;
  fileCount: number;
  createdAt: number;
}

export interface UsageTotals {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** An estimate from the SDK, not a bill. */
  costUsd: number;
}

/** Tokens and cost of one agent run. */
export interface UsageRecord extends Omit<UsageTotals, 'runs'> {
  id: number;
  projectId: number | null;
  cardId: number | null;
  profileId: number | null;
  model: string;
  ts: number;
}

export interface Card {
  id: number;
  /** Card ids are unique across projects, so `#12` always means one card. */
  projectId: number;
  kind: CardKind;
  title: string;
  description: string;
  instructions: string;
  /** Hash of the description the instructions were generated from. */
  instructionsHash: string | null;
  /** True when the instructions were generated from the current description. */
  instructionsCurrent: boolean;
  stage: Stage;
  position: number;
  /** Short machine status, e.g. "planning", "running", "testing". */
  status: string;
  /** Human-readable status line shown on the card. */
  statusText: string;
  tags: number[];
  parentId: number | null;
  branch: string | null;
  worktree: string | null;
  /** How many times the card has bounced back to In Progress. */
  loops: number;
  coverage: number | null;
  acceptanceReady: boolean;
  deliverableKind: DeliverableKind | null;
  /** Stage to return to when a blocked card gets its input. */
  resumeStage: Stage | null;
  /** Names of secrets attached to the card (values are never sent to the client). */
  secretNames: string[];
  hidden: boolean;
  createdAt: number;
  updatedAt: number;
  stageChangedAt: number;
  completedAt: number | null;
  /** Set once the card is complete; re-checked against git so manual merges show up. */
  mergeState: MergeState | null;
  /** Why, e.g. "Kept on factory/card-4" or "main checkout has uncommitted changes". */
  mergeNote: string;
  /** A merge into the base branch was requested and isn't finished (it may be re-verifying). */
  merging: boolean;
}

export type SubtaskKind = 'build' | 'fix' | 'acceptance' | 'merge';
export type SubtaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'aborted' | 'blocked';

export interface Subtask {
  id: number;
  cardId: number;
  seq: number;
  round: number;
  kind: SubtaskKind;
  title: string;
  instructions: string;
  /** Measurable definition of done for the worker. */
  doneWhen: string;
  dependsOn: number[];
  status: SubtaskStatus;
  worker: string | null;
  /** The agent profile that did (or is doing) this subtask. */
  profileId: number | null;
  branch: string | null;
  worktree: string | null;
  summary: string;
  diff: string;
  files: FileChange[];
  attempts: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
}

/** The four log forms: one-liner, summary, details, diff. */
export type LogLevel = 'oneliner' | 'summary' | 'detail' | 'diff';

export interface LogEntry {
  id: number;
  cardId: number;
  subtaskId: number | null;
  actor: string;
  /** The profile that wrote it; role logs without one show the project's current profile for that role. */
  profileId: number | null;
  level: LogLevel;
  text: string;
  ts: number;
}

export type CommentAuthor = 'user' | 'coordinator';
export type CommentKind = 'note' | 'question' | 'input' | 'reply' | 'approval' | 'changes' | 'handoff';

export interface Comment {
  id: number;
  cardId: number;
  author: CommentAuthor;
  kind: CommentKind;
  body: string;
  /** Set when the assistant passed the user's words on to this thread. */
  via: 'assistant' | null;
  ts: number;
}

/** Agent CLIs the factory knows about. */
export const PROVIDERS = ['claude', 'codex', 'opencode', 'pi'] as const;
export type ProviderId = (typeof PROVIDERS)[number];
export const PROVIDER_LABELS: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi' };
/** Providers with a driver. A new provider can be set up before it joins this list, but not chosen. */
export const WORK_PROVIDERS: readonly ProviderId[] = ['claude', 'codex', 'opencode', 'pi'];

/** What runs a project's (or the assistant's) agents: the token-free simulation or a provider. */
export type DriverName = 'simulated' | ProviderId;

/** A provider as this machine has it: installed or not, switched on or off. */
export interface ProviderStatus {
  id: ProviderId;
  label: string;
  command: string;
  available: boolean;
  version: string | null;
  path: string | null;
  enabled: boolean;
  runsWork: boolean;
  /** Model ids to suggest; empty means type any id. */
  models: string[];
  /** The CLI version the factory's parser was checked against, or null when it doesn't read the CLI's output (Claude runs through its SDK). */
  tested: string | null;
  /** How the installed version compares with `tested`. */
  versionCheck: 'tested' | 'newer' | 'older' | 'unknown' | null;
}

export interface Settings {
  /** Absolute path to the git repository agents work on. */
  repoPath: string;
  /** The project's logo: an uploaded image (/uploads/…) or an http(s) link; empty shows the factory's. */
  logoUrl: string;
  baseBranch: string;
  /** Max cards the coordinator works on at once. */
  maxActiveCards: number;
  /** Max worker agents running at once, across all cards. */
  maxWorkers: number;
  /** Runs in every new worktree, e.g. "npm ci". */
  setupCommand: string;
  testCommand: string;
  coverageCommand: string;
  coverageMin: number;
  coverageTarget: number;
  /** {card} expands to the card id. */
  acceptanceCommand: string;
  /** Focus areas for the architect's review; one pass per lens. */
  auditLenses: string[];
  /** Bounces back to In Progress before the card is escalated to Deliverables. */
  maxLoops: number;
  /** What to do with the card branch when it reaches Complete. */
  onComplete: 'keep' | 'merge';
  completeRetentionDays: number;
  paused: boolean;
  /** Profiles that work on this project; empty means every profile. */
  team: number[];
  /** Git remote to pull from and push to, when the repository has it. */
  remote: string;
  /** Monthly limits on this project's runs; 0 means no limit. Reaching one pauses the coordinator. */
  budgetUsd: number;
  budgetTokens: number;
}

/** One repository with its own board, coordinator and settings. */
export interface Project {
  id: number;
  name: string;
  settings: Settings;
  createdAt: number;
  /** The configured remote's URL, when the repository has that remote. */
  remoteUrl: string | null;
}

/**
 * message: conversation; notification: an unprompted update; relay: a
 * coordinator's reply passed on; action: what code actually did; error: an
 * action or reply that failed.
 */
export type AssistantMessageKind = 'message' | 'notification' | 'relay' | 'action' | 'error';

export interface AssistantMessage {
  id: number;
  author: 'user' | 'assistant';
  kind: AssistantMessageKind;
  body: string;
  /** Cards shown as clickable previews under the message. */
  cardIds: number[];
  /** Long-form markdown shown collapsed, e.g. generated agent instructions. */
  details: string;
  ts: number;
}

export interface AssistantState {
  messages: AssistantMessage[];
  busy: boolean;
}

export type FactoryEvent =
  | { type: 'card'; card: Card }
  | { type: 'card_removed'; id: number }
  | { type: 'subtask'; subtask: Subtask }
  | { type: 'log'; log: LogEntry }
  | { type: 'comment'; comment: Comment }
  | { type: 'chat'; cardId: number; busy: boolean }
  | { type: 'project'; project: Project }
  | { type: 'coordinator'; projectId: number; text: string; ts: number }
  | { type: 'assistant_message'; message: AssistantMessage }
  | { type: 'assistant_busy'; busy: boolean }
  | { type: 'profile'; profile: AgentProfile }
  | { type: 'skill'; skill: Skill }
  | { type: 'skill_removed'; id: number }
  | { type: 'context'; context: Context }
  | { type: 'context_removed'; id: number }
  | { type: 'usage'; record: UsageRecord }
  | { type: 'providers'; providers: ProviderStatus[] }
  | { type: 'limits'; limits: RunLimits }
  | { type: 'jev'; jev: JevStatus };

/** Everything a client needs on (re)connect. */
export interface FactoryState {
  projects: Project[];
  cards: Card[];
  /** Prefills the new-project form. */
  projectDefaults: Settings;
  assistant: AssistantState;
  profiles: AgentProfile[];
  skills: Skill[];
  contexts: Context[];
  providers: ProviderStatus[];
  jev: JevStatus;
  usage: { byProject: Record<number, UsageTotals>; byProfile: Record<number, UsageTotals>; month: MonthUsage };
  limits: RunLimits;
}

export interface CardDetail {
  card: Card;
  subtasks: Subtask[];
  logs: LogEntry[];
  comments: Comment[];
  deliveryNotes: string;
  chatBusy: boolean;
  usage: UsageTotals;
}

/** Processes the factory can identify and stop without accepting arbitrary PIDs. */
export interface ProjectProcess {
  id: string;
  summary: string;
  pid: number | null;
  url: string;
  startedAt: string;
  stopsAt: string | null;
  currentServer: boolean;
}
