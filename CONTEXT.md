# CONTEXT.md

What this project is, the vocabulary it uses, and the decisions behind it. `README.md` covers how to run it; `AGENTS.md` covers how to change it.

## Purpose

A **software factory**: a kanban board where a human writes tasks and AI agents carry them from idea to verified, accepted code. The human stays in charge of *what* gets built and *when* it starts. The agents handle *how*, and must prove the result works before anyone is asked to look at it.

Two goals shape most decisions:

1. **Reduce vagueness before work starts.** Every task is rewritten as agent instructions that the human reviews and iterates on.
2. **Don't hand humans unverified work.** Every card passes tests, coverage, a senior audit and acceptance tests. A person sees it only when the card truly needs one.

## Glossary

| Term | Meaning |
|---|---|
| **Project** | One git repository with its own board, coordinator and settings (driver, quality gates, pause). Card ids are unique across projects, so `#12` always means one card. |
| **Assistant** | The cross-project agent on the home screen (displayed as Ada Lovelace · Chief of Staff). The user talks to it about every project; it proposes actions that code validates and performs. |
| **Card** | One task. It has a **description** (the human's markdown) and **agent instructions** (the coordinator's reading of it). Cards reference each other with `#id`. |
| **Stage** | A board column: Icebox → Backlog → In Progress → Verification → Acceptance → Deliverables → Complete. |
| **Coordinator** | The orchestrator (`server/coordinator.ts`), one per project. It schedules, plans, assigns, verifies, loops and escalates. It is deterministic code that consults an agent for judgement calls. |
| **Worker** | An agent that builds one subtask inside its own worktree. |
| **Senior** | The auditor agent in Verification. It reviews and recommends but never edits. |
| **Subtask** | A small, measurable piece of a card with a `doneWhen`. Kinds: `build`, `fix`, `merge`, `acceptance`. |
| **Round** | A batch of subtasks: round 1 is the plan, later rounds are rework or acceptance scripts. |
| **Loop** | One bounce from Verification or Acceptance back to In Progress. Capped by `maxLoops`, then escalated. |
| **Lens** | One focus area for a senior audit pass (logic, structure, craft). One pass per lens. |
| **Deliverable kind** | Why a card waits on the human: `approval` (please check), `input` (credential or decision needed), `blocked` (failing or errored, needs help). |
| **Driver** | The backend that answers the coordinator's questions: `claude` (Claude Agent SDK) or `simulated` (deterministic, no tokens). |
| **Worktree** | A git worktree. Card branch `factory/card-<id>`; subtask branch `factory/card-<id>-s<seq>`, forked from the card branch and merged back into it. Aborted branches move to `factory/archive/…`. |

## Lifecycle rules

- **Creating** a card always puts it in the **Icebox**, even with just a title. Instructions can be added later.
- **Icebox** cards are editable, and no agent ever touches them.
- **Into the Backlog:** only the human can move a card there (drag, the "Move to Backlog" button, or explicitly asking the assistant). This needs instructions generated from the *current* description, or ones explicitly kept with "Keep as is".
- **The Backlog is a priority queue**, top first. The coordinator starts a card when there is capacity (`maxActiveCards`). It skips any card that references a card still in flight, to avoid conflicting edits.
- **From the Backlog on**, the card can't be edited. The human can chat with the coordinator throughout work and after completion, abort active work, and use explicit approval, change-request or resume controls in Deliverables. Chat alone does not approve or queue work.
- **Fixes:** Verification and Acceptance failures become `fix` subtasks in a new round, and the card returns to the top of In Progress.
- **Approval:** after acceptance passes, the coordinator decides whether a human is needed. Complete means nobody needs to look.
- **Abort** stops the agents, removes the worktrees, archives the branches, and returns the card to the Icebox, editable again.
- **Complete** cards stay visible for `completeRetentionDays` (7 by default) unless hidden. A follow-up card references the original.
- **Merge state:** a completed card records whether its branch reached the base branch: *Merged*, *Not merged* (kept, the default), or *Merge blocked* (an automatic merge refused, e.g. a dirty main checkout or a conflict, with the reason). Worktrees are always removed on completion; the work lives on `factory/card-<id>`. The coordinator re-checks unmerged branches every 30 seconds, so a merge made by hand shows up.
- **Merging** (the **Merge into main** button, the assistant's "merge #N", or *Merge into base branch* projects automatically) only ever lands verified code. If the base branch hasn't moved since the card branched, the card stays in Complete and merges in seconds. If it has, the coordinator brings the branch up to date: conflicts go to a worker as a `merge` subtask in **In Progress**, then the card passes **Verification** and **Acceptance** again (skipping approval, which already happened) before the base branch moves. There is no Merging column; a *Merging…* badge explains a finished card back on the board. Merge passes count toward `maxLoops`; if the base keeps moving, the merge is marked blocked. Aborting a merge pass cancels only the merge: the card returns to Complete, its branch kept. The base branch is updated without touching the main checkout unless it has the base branch checked out, and then only when clean.

## Key decisions

- **Projects share one process and one database.** Each project gets its own coordinator (`server/factory.ts` holds them), settings and board positions; cards carry a `projectId`. A database from before projects opens as one project with its old settings and cards.
- **One assistant for every project.** It answers briefly and at a high level by default, gives suggestions only when asked, and acts only on an explicit request: draft or edit Icebox cards, queue them, message a card's coordinator, approve, request changes or resume. Drafted cards get instructions generated straight away and shown in the chat for confirmation before anything is queued. The agent proposes structured actions; `server/assistant.ts` validates them with the same rules as the board's controls and posts what actually happened as separate messages.
- **Notifications are code, not judgement.** The assistant announces completed cards (and when a project has nothing left in flight), cards entering Deliverables with the coordinator's open questions, and coordinator replies to messages it passed on. No agent call is needed, so none are missed. Secrets never go through the assistant; it points the user to the card's Secret field.

- **Code-driven state machine, agent-driven judgement.** Stage transitions, retries, limits and concurrency are plain TypeScript, so they're predictable and testable. Agents are asked narrow questions (plan this, build this, audit this, does this need a human?) and answer with structured JSON where possible.
- **Isolation through git worktrees.** Each subtask gets its own checkout, so parallel workers can't collide. Merging back is where conflicts surface, and a conflict becomes a `merge` subtask instead of a failure.
- **Bounded autonomy.** Every retry path counts toward a limit, then escalates to the human. The factory never loops forever.
- **The human-in-the-loop channel is a conversation**, not a form. The coordinator can push back on unclear or risky input instead of acting on it blindly.
- **Chat is available throughout the work and after completion.** Questions do not change lifecycle state. Clear development requests become linked Icebox drafts; vague requests are clarified first. Only the user's explicit Backlog move starts new work. Review handoffs persist before worktree cleanup.
- **Secrets are first-class.** Workers can ask for credentials. Values are stored locally, injected as environment variables, and never shown back or logged.
- **A simulated driver ships with it**, so the whole flow can be explored and tested without spending tokens. It makes real commits, merges and diffs.
- **Local-first.** It is a single Node process with SQLite, SSE for live updates, and no external services beyond the model API.
- **Managed local servers.** Development and review servers run through devmetrics on assigned localhost ports 3000–3020, with a scheduled stop. Acceptance tests use a managed server and isolated temporary data, then stop it and remove that data.

## Agent permissions

| Role | Tools | Working directory |
|---|---|---|
| Instruction writer | Read, Glob, Grep | the main repository (read-only) |
| Planner | Read, Glob, Grep | the card worktree |
| Worker | everything, permissions bypassed, plus `log_activity` and `request_human_input` | its own subtask worktree |
| Senior auditor | Read, Glob, Grep, `git diff/log/show/status` | the card worktree |
| Approval decision | Read, Glob, Grep | the card worktree, or the factory directory if unavailable |
| Review handoff | Read, Glob, Grep | the card worktree before cleanup |
| Coordinator reply | Read, Glob, Grep | the configured main repository (read-only) |
| Assistant | one read-only `card_details` tool; no file, shell or settings access | the factory data directory, unused |

## Interface decisions

- **Home is the default screen.** It lists projects beside the assistant. Clicking a project opens its board; card previews in the chat open the card panel over the conversation (`#chat/card-12`), with a control to open the card's board. A green dot on the board's logo marks assistant messages not yet seen on the home screen (per browser). Projects take a quarter of the width and the conversation the rest. Project tiles show the last two folders of the repository path, with a control to copy the full path.
- **Every stage change is logged with its reason** (`db.moveCard`), as a coordinator message in Team Chat, e.g. "Complete → In Progress: main conflicts with … in `x.ts`". Merges also record who asked and each git command with the SHAs before and after, as that message's details.
- **Merge state is an icon:** a green link when merged, a red broken link otherwise; the name and reason are its accessible label and tooltip. Subtasks carry no kind badges; round headings (Plan, Rework, Merge with main, Acceptance scripts) say what each round was, and titles stay on one line.
- **Settings are sectioned.** Project settings (and the new-project form) use a left menu of Project, Agents and Quality gates, one section at a time; on phones the menu becomes a row above the section.
- **Keep the board compact.** The top bar shows the factory logo, which links back to all projects, and the project's name. The logo itself carries no text title; columns and the Thread composer omit explanatory hints. Controls retain accessible labels. Shared Lucide icons follow the installed `.agents/skills/chrisai-iconography` profile.
- **Keep navigation and composition visible.** Card sections remain above their scrolling content. Thread uses the same Markdown editor as card creation, with Write/Preview, card references and image attachments; its composer stays below the independently scrolling conversation. Subtask rounds and the tasks within them show newest first.
- **Show unread content without counters.** Overview, Subtasks, Activity and Thread use green dots for changed, unread content. Opening a tab clears its dot. Receipts are stored per card in this browser, and content changes can mark an inactive tab unread again.
- **Make recorded activity readable as a conversation.** Activity defaults to Team Chat, followed by Logs and Diffs, without counters. Coordinator bubbles sit on the right; other agents sit on the left. Messages expose a details control only when recorded details exist; detail-only output is preserved.
- **Names and jobs explain example profiles.** Coordinator, Designer, Developer, Auditor and Senior Developer labels describe the existing agent's assignment and context. Names are display profiles, not claims that the named people participated. Designer and Auditor use the existing worker driver and permissions. The UI's profile guide explains these contexts.
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
- **No per-card cost tracking yet.** The Agent SDK reports `total_cost_usd` per run, so it could be summed per card.
- **Card ordering in active columns** is set by the coordinator (newest arrivals on top) and can't be changed by hand.
- **Deleting a card is a soft delete** (it's just hidden) and can't be undone from the UI.
