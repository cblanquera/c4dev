# CONTEXT.md

What this project is, the vocabulary it uses, and the decisions behind it. `README.md` covers how to run it; `AGENTS.md` covers how to change it.

## Purpose

A **software factory**: a kanban board where a human writes tasks and AI agents carry them from idea to verified, accepted code. The human stays in charge of *what* gets built and *when* it starts. The agents handle *how*, and must prove the result works before anyone is asked to look at it.

Two goals shape most decisions:

1. **Reduce vagueness before work starts.** Every task is rewritten as agent instructions that the human reviews and iterates on.
2. **Don't hand humans unverified work.** Every card passes tests, coverage, an architect's review and acceptance tests. A person sees it only when the card truly needs one.

## Glossary

| Term | Meaning |
|---|---|
| **Project** | One git repository with its own board, coordinator and settings (driver, quality gates, pause). Card ids are unique across projects, so `#12` always means one card. |
| **Agent profile** | A named agent (picture, role, job title, brief, optional model, uploaded skills) that does runs. Roles: coordinator, worker, auditor, architect, chief of staff. The job title shows beside the name, defaults to the role, and steers design work. |
| **Skills library** | Skills (a folder with a SKILL.md and any files it uses) imported from a folder, a GitHub repository or skills.sh. Agents attach skills from it. |
| **Team** | The profiles a project lets work on it (`settings.team`); empty means everyone. |
| **Integration card** | A merge, pull or push card the factory queues itself. It starts in the Backlog and is marked and filterable apart from your tasks. |
| **Assistant** | The cross-project agent on the home screen (displayed as Ada Lovelace · Chief of Staff). The user talks to it about every project; it proposes actions that code validates and performs. |
| **Card** | One task. It has a **description** (the human's markdown) and **agent instructions** (the coordinator's reading of it). Cards reference each other with `#id`. |
| **Stage** | A board column: Icebox → Backlog → In Progress → Verification → Acceptance → Deliverables → Complete. |
| **Coordinator** | The orchestrator (`server/coordinator.ts`), one per project. It schedules, plans, assigns, verifies, loops and escalates. It is deterministic code that consults an agent for judgement calls. |
| **Worker** | An agent that builds one subtask inside its own worktree. |
| **Architect** | The reviewer in Verification (stored as role `senior`). It reviews and recommends but never edits. |
| **Worker** | A profile that builds subtasks (stored as role `developer`). There is no separate designer role: design work prefers workers whose job title mentions design. |
| **Subtask** | A small, measurable piece of a card with a `doneWhen`. Kinds: `build`, `fix`, `merge`, `acceptance`. |
| **Round** | A batch of subtasks: round 1 is the plan, later rounds are rework or acceptance scripts. |
| **Loop** | One bounce from Verification or Acceptance back to In Progress. Capped by `maxLoops`, then escalated. |
| **Lens** | One focus area for an architect review pass (logic, structure, craft). One pass per lens. |
| **Deliverable kind** | Why a card waits on the human: `approval` (please check), `input` (credential or decision needed), `blocked` (failing or errored, needs help). |
| **Driver** | The backend that answers the coordinator's questions: `simulated` (deterministic, no tokens) or a provider. |
| **Provider** | An agent CLI on this machine: Claude (through the Agent SDK), Codex, OpenCode or Pi. Settings → Providers shows whether each is installed and switches it on or off; any switched-on provider can run factory work. |
| **Worktree** | A git worktree. Card branch `factory/card-<id>`; subtask branch `factory/card-<id>-s<seq>`, forked from the card branch and merged back into it. Aborted branches move to `factory/archive/…`. |

## Lifecycle rules

- **Creating** a task always puts it in the **Icebox**, even with just a title. Instructions can be added later. Integration cards (merge, pull, push) are the exception: the factory queues them straight into the **Backlog**, and they can't be dragged or edited, only cancelled.
- **Icebox** cards are editable, and no agent ever touches them.
- **Into the Backlog:** only the human can move a card there (drag, the "Move to Backlog" button, or explicitly asking the assistant). This needs instructions generated from the *current* description, or ones explicitly kept with "Keep as is".
- **The Backlog is a priority queue**, top first. The coordinator starts a card when there is capacity (`maxActiveCards`). It skips any card that references a card still in flight, to avoid conflicting edits.
- **From the Backlog on**, the card can't be edited. The human can chat with the coordinator throughout work and after completion, abort active work, and use explicit approval, change-request or resume controls in Deliverables. Chat alone does not approve or queue work.
- **Fixes:** Verification and Acceptance failures become `fix` subtasks in a new round, and the card returns to the top of In Progress.
- **Approval:** after acceptance passes, the coordinator decides whether a human is needed. Complete means nobody needs to look.
- **Abort** stops the agents, removes the worktrees, archives the branches, and returns the card to the Icebox, editable again.
- **Complete** cards stay visible for `completeRetentionDays` (7 by default) unless hidden. A follow-up card references the original.
- **Merge state:** a completed card records whether its branch reached the base branch: *Merged*, *Not merged* (kept, the default), or *Merge blocked* (an automatic merge refused, e.g. a dirty main checkout or a conflict, with the reason). Worktrees are always removed on completion; the work lives on `factory/card-<id>`. The coordinator re-checks unmerged branches every 30 seconds, so a merge made by hand shows up.
- **Merging, pulling and pushing are cards.** **Merge into main** (or the assistant's "merge #N", or *Merge into base branch* projects automatically) queues a merge card working on the finished card's branch; the finished card stays in Complete with a *Merging…* badge. **Pull** and **Push** (shown when the repository has the configured remote, and offered to the assistant) queue pull and push cards; an open one is reused. A successful merge queues a push when there's a remote.
- **Only verified code reaches the base branch.** One integration card runs at a time per project. It fetches the remote, then lands immediately when nothing new needs merging (up to date, a fast-forward, or a branch that already contains everything). Otherwise it merges what's new in a worktree: conflicts go to a worker in **In Progress**, then **Verification** runs the tests (no coverage gate, since the incoming code isn't the card's), plus one senior review when a worker resolved conflicts; merge cards also rerun the finished card's acceptance scripts. Only then does the base branch move, and push cards push, never with force. Retries count toward `maxLoops`. A dirty main checkout or a failed fetch/push escalates to **Deliverables**. Cancelling an integration card archives nothing; a merge card's finished card keeps its branch.
- **Network git uses this machine's credentials** and never prompts: it fails instead (`GIT_TERMINAL_PROMPT=0`, SSH batch mode), with a timeout.

## Key decisions

- **Projects share one process and one database.** Each project gets its own coordinator (`server/factory.ts` holds them), settings and board positions; cards carry a `projectId`. A database from before projects opens as one project with its old settings and cards.
- **One assistant for every project.** It answers briefly and at a high level by default, gives suggestions only when asked, and acts only on an explicit request: draft or edit Icebox cards, queue them, message a card's coordinator, approve, request changes or resume. Drafted cards get instructions generated straight away and shown in the chat for confirmation before anything is queued. The agent proposes structured actions; `server/assistant.ts` validates them with the same rules as the board's controls and posts what actually happened as separate messages.
- **Notifications are code, not judgement.** The assistant announces completed cards (and when a project has nothing left in flight), cards entering Deliverables with the coordinator's open questions, and coordinator replies to messages it passed on. No agent call is needed, so none are missed. Secrets never go through the assistant; it points the user to the card's Secret field.

- **Code-driven state machine, agent-driven judgement.** Stage transitions, retries, limits and concurrency are plain TypeScript, so they're predictable and testable. Agents are asked narrow questions (plan this, build this, audit this, does this need a human?) and answer with structured JSON where possible.
- **Isolation through git worktrees.** Each subtask gets its own checkout, so parallel workers can't collide. Merging back is where conflicts surface, and a conflict becomes a `merge` subtask instead of a failure.
- **Profiles do the runs.** Every run is done by a profile: the project's coordinator plans, decides and talks; a senior developer audits; each subtask goes to the least busy team member whose role fits (tests and acceptance → auditor, else worker; design work prefers workers whose job title mentions design; auditors fall back to workers). A profile's brief is appended to the role's system prompt and can't override its rules or permissions. Its skills come from the library and load, whole folders included, through a per-profile plugin folder outside every repository. Deleted profiles are archived, so recorded activity keeps their name and picture; jobs projects rely on can't lose their last profile.
- **The skills library fills from three sources.** A folder picked in the browser: every SKILL.md inside it (skipping `.git` and `node_modules`) becomes a skill with the files beside it. A GitHub link (`/tree/<branch>/<path>` too): a SKILL.md at the root makes a single-skill repository, otherwise its `skills/` folder (or the whole repository without one) is searched. A skills.sh link or `owner/repo[/skill]`: skills.sh lists GitHub repositories, so the entry is imported from its repository; its API needs a Vercel token, so it isn't used, and entries published from websites aren't supported. Repositories are cloned shallowly with this machine's git credentials, never prompting. Re-importing a skill of the same name replaces it; paths must stay inside the skill folder, within 300 files and 5 MB.
- **Usage is recorded per run** (tokens and the SDK's cost estimate) against the project, card and profile. The simulated driver records estimated tokens at no cost. Runs before tracking existed aren't counted.
- **Bounded autonomy.** Every retry path counts toward a limit, then escalates to the human. The factory never loops forever.
- **Spend is capped twice.** Every run has a turn and a time limit (Settings → Limits, 200 turns and 60 minutes by default); Claude gets `maxTurns`, and the CLIs' tool calls are counted. A run that hits one fails like any other, so it's retried and then escalated. Monthly budgets, set per project (Team) and per agent (Usage), cap spend (the providers' estimates) and tokens (input plus output, which also covers Codex, which reports no cost); months start on the 1st. Budgets are checked before each run, never mid-run. Over a project's budget, active cards advance until their next run, wait in Deliverables saying why, and the coordinator pauses. An agent over its budget is passed over while a teammate can do the work; otherwise the card waits. The assistant over its budget says so instead of answering. Moving an agent off Simulated asks for confirmation, mentioning its budget.
- **The human-in-the-loop channel is a conversation**, not a form. The coordinator can push back on unclear or risky input instead of acting on it blindly.
- **Chat is available throughout the work and after completion.** Questions do not change lifecycle state. Clear development requests become linked Icebox drafts; vague requests are clarified first. Only the user's explicit Backlog move starts new work. Review handoffs persist before worktree cleanup.
- **Secrets are first-class.** Workers can ask for credentials. Values are stored locally, encrypted (AES-256-GCM, key in `.factory/secret.key` or `FACTORY_SECRET_KEY`), injected as environment variables, and never shown back, logged or exported. Cards keep only the names.
- **Upgrades are safe to undo.** The schema version is SQLite's `user_version`. Before an older database is upgraded it is copied to `.factory/backups/` (secrets encrypted in the copy too); a database from a newer factory is refused rather than damaged. Settings → Data takes backups on request (the latest ten are kept) and exports the setup (skills, agents with pictures, project settings, never cards or secrets) to import on another machine. Importing merges skills and agents by name, the Chief of Staff by role, and projects by folder; providers that aren't switched on fall back to Simulated.
- **A simulated driver ships with it**, so the whole flow can be explored and tested without spending tokens. It makes real commits, merges and diffs.
- **Local-first.** It is a single Node process with SQLite, SSE for live updates, and no external services beyond the model API.
- **Only this machine's own UI can use the API.** Listening on 127.0.0.1 doesn't stop websites in the browser from sending requests to localhost, and the API can list folders, start agents with write access and accept secrets. So every request must be addressed to a loopback host (no DNS rebinding), nothing may come from another origin (`Origin`, `Sec-Fetch-Site`; pages can still be opened from a link), and the API needs this install's token from `.factory/auth-token` (mode 600). The server writes the token into `index.html`, as Vite does in development (with CORS off, so other localhost pages can't read it). The client sends it as `X-Factory-Token`; only the event stream takes it as `?token=`, because EventSource can't send headers. Uploads need no token but can't be fetched from other sites.
- **Managed local servers.** Development and review servers run through devmetrics on assigned localhost ports 3000–3020, with a scheduled stop. Acceptance tests use a managed server and isolated temporary data, then stop it and remove that data.

## Agent permissions

| Role | Tools | Working directory |
|---|---|---|
| Instruction writer | Read, Glob, Grep | the main repository (read-only) |
| Planner | Read, Glob, Grep | the card worktree |
| Worker | everything, permissions bypassed, plus `log_activity` and `request_human_input` | its own subtask worktree |
| Architect | Read, Glob, Grep, `git diff/log/show/status` | the card worktree |
| Approval decision | Read, Glob, Grep | the card worktree, or the factory directory if unavailable |
| Review handoff | Read, Glob, Grep | the card worktree before cleanup |
| Coordinator reply | Read, Glob, Grep | the configured main repository (read-only) |
| Assistant | one read-only `card_details` tool; no file, shell or settings access | the factory data directory, unused |

Every role also gets its profile's brief and skills; neither changes the tools above.

On the agent CLIs (`server/agents/cli.ts`), each role is one non-interactive run whose access the CLI enforces:

| Access | Codex | OpenCode | Pi |
|---|---|---|---|
| Read-only roles (instructions, planner, architect, approval, handoff, reply) | `exec -s read-only` | `run --agent plan` (approvals refused without a person) | `--tools read,grep,find,ls` |
| Workers | `exec -s workspace-write`, network on | `run --agent build --auto` | adds `bash,edit,write` |
| Assistant | read-only in an empty folder | `plan` in an empty folder | `--no-tools` in an empty folder |

Structured answers use Codex's `--output-schema`; OpenCode and Pi are asked for JSON, which is parsed from their last message. Workers can't call factory tools there, so needing a person is part of their final answer, and activity is logged from their tool use. The architect is given the diff, since not every read-only CLI can run git. The assistant can't look cards up, so cards the user mentions are included up front.

## Interface decisions

- **Home is the default screen.** It lists projects beside the assistant. Clicking a project opens its board; card previews in the chat open the card panel over the conversation (`#chat/card-12`), with a control to open the card's board. A green dot on the board's logo marks assistant messages not yet seen on the home screen (per browser). Projects take a quarter of the width and the conversation the rest. Project tiles show the last two folders of the repository path, with a control to copy the full path.
- **Every stage change is logged with its reason** (`db.moveCard`), as a coordinator message in Team Chat, e.g. "Complete → In Progress: main conflicts with … in `x.ts`". Merges also record who asked and each git command with the SHAs before and after, as that message's details.
- **Each agent chooses its provider and model**, and that is what runs it: there is no project-level or assistant-level model. The assistant is the Chief of Staff agent, whose provider and model are changed in its profile. Agents offer Simulated and switched-on providers (the server refuses switched-off ones); an empty model uses the provider's default. Existing agents took what their project, or the assistant, used to run on. The board and project tiles show what a team runs on. Models are suggested in a dropdown under the field, filtered as you type, from what each provider lists without a prompt (Claude's known ids, `codex debug models`, `opencode models`, `pi --list-models`); any id can be typed. A provider an agent uses can't be switched off, and only an installed one can be switched on.
- **Project path** is chosen with a folder browser: the server lists folder names (never file contents), marks git repositories, and can show hidden folders; a browser's own folder picker can't reveal real paths. Project settings are Project, Team (including how many cards and workers at once) and Quality gates.
- **Settings is a page** (`#settings/agents|skills|providers`; the old `#settings/assistant` opens Agents), with **Back to App** at the top of its menu, opened from the home screen's gear, with its sections in a left menu (a row on phones). Skills shows the library; **Add skills** opens a dialog with Local, GitHub and Skills.sh tabs. The agent editor's skill picker can be searched. **There is exactly one Chief of Staff**, shown first in Agents with an Assistant badge: the assistant always runs as it, so it can't be deleted, its role can't change and no other agent can take that role (the server refuses all three; a database without one gets Ada Lovelace back). The other agents are grouped as Coordinators, Workers, Auditors and Architects, with picture, title, skills, projects and usage; the editor (Profile, Context, Skills, Usage) opens over it. Projects choose their team in a **Team** settings section showing each agent's usage there. Agent names in Team Chat, Thread and the assistant show their picture or initials.
- **Integration cards look different:** a dashed, tinted tile with a Merge/Pull/Push badge. The board's type filter (Tasks, Merges, Pulls, Pushes) is remembered per project in this browser.
- **Merge state is an icon:** a green link when merged, a red broken link otherwise; the name and reason are its accessible label and tooltip. Subtasks carry no kind badges; round headings (Plan, Rework, Merge with main, Acceptance scripts) say what each round was, and titles stay on one line.
- **Settings are sectioned.** Project settings (and the new-project form) use a left menu of Project, Agents and Quality gates, one section at a time; on phones the menu becomes a row above the section.
- **Keep the board compact.** The top bar shows the factory logo, which links back to all projects, and the project's name. The logo itself carries no text title; columns and the Thread composer omit explanatory hints. Controls retain accessible labels. Shared Lucide icons follow the installed `.agents/skills/chrisai-iconography` profile.
- **Keep navigation and composition visible.** Card sections remain above their scrolling content. Thread uses the same Markdown editor as card creation, with Write/Preview, card references and image attachments; its composer stays below the independently scrolling conversation. Subtask rounds and the tasks within them show newest first.
- **Show unread content without counters.** Overview, Subtasks, Activity and Thread use green dots for changed, unread content. Opening a tab clears its dot. Receipts are stored per card in this browser, and content changes can mark an inactive tab unread again.
- **Make recorded activity readable as a conversation.** Activity defaults to Team Chat, followed by Logs and Diffs, without counters. Coordinator bubbles sit on the right; other agents sit on the left. Messages expose a details control only when recorded details exist; detail-only output is preserved.
- **Roles explain what a profile does.** Coordinator, Worker, Designer, Auditor, Architect and Chief of Staff describe each run's assignment and context; a job title can rename it for display. Designers and auditors use the worker driver and permissions. The activity guide explains each role.
- **Agent-name colors are stable across jobs and themes.** The ten base profiles have distinct colors; extended names reuse the approved palette deterministically. `web/src/agent-colors.ts` is the canonical inventory and [docs/agent-colors.md](docs/agent-colors.md) records paired light/dark shades and contrast requirements.
- **Review instructions survive completion.** Thread records what changed, how to view it, available preview URLs and test access, verification and limitations before worktrees are removed. Missing access information is called out rather than invented; older cards fall back to recorded activity. The simulated driver produces notes and git history, not a working implementation of the requested app.
- **Background-process controls are factory scoped.** The terminal button beside Settings lists only devmetrics-managed servers associated with the factory, any project's repository or their worktrees. Stop targets the exact registered server identity, without arbitrary process IDs or shell commands. Stopping the factory API disconnects the UI.

## Current state

- Working end to end with both drivers. The Claude driver has been smoke-tested on the demo repo (instructions, planning, a worker run), and its read-only review handoff and conversation reply were checked in a temporary repository.
- Tests: node:test (unit + full pipeline) and Playwright acceptance tests (desktop + mobile).

## Known limitations and ideas

- **No auth.** It's a single-user, local tool; don't expose the port.
- **Changing the repository path** while cards are in flight isn't handled. Pause the project's coordinator first.
- **Projects can't be deleted or archived** from the UI yet.
- **Relayed coordinator replies are tracked in memory.** A reply that arrives after a restart stays in the card thread but isn't passed on to the assistant chat.
- **"Merge into base"** only works when the main checkout is on the base branch and clean. Otherwise the branch is kept. Opening a pull request instead would be a natural next step.
- **Usage budgets aren't enforced**; usage is tracked and shown only.
- **skills.sh search isn't built in**; paste an entry's link. Its API needs a Vercel OIDC token.
- **Skills load only on Claude.** Codex, OpenCode and Pi runs get the profile's brief but not its skills.
- **Codex reports tokens but no cost**, so its usage shows $0. OpenCode and Pi report cost.
- **A provider's default model must support tools.** OpenCode's default on a machine may not; pick a model in the project's settings.
- **Card ordering in active columns** is set by the coordinator (newest arrivals on top) and can't be changed by hand.
- **Deleting a card is a soft delete** (it's just hidden) and can't be undone from the UI.
