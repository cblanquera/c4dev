# Software Factory

A kanban board where you write tasks and a **coordinator** agent takes them the rest of the way. It plans each task, hands subtasks to **worker** agents in isolated git worktrees, verifies the work with tests, coverage and a **senior** audit, writes and runs acceptance scripts, and asks you only when it needs you.

```
Icebox ─(you drag)─▶ Backlog ─plan─▶ In Progress ─▶ Verification ─▶ Acceptance ─┬─▶ Complete
   ▲                    │                ▲  ▲            │               │        │
   └──── abort ─────────┘                │  └─ fixes ◀───┘               │        └─▶ Deliverables ─▶ Complete
                                         └──── fixes ◀───────────────────┘              (you approve / reply)
```

## Quick start

```bash
npm install
npm run build
devmetrics list
devmetrics start --summary "C4Dev app review" -- 'PORT={port} npm start'
```

Use the URL returned by devmetrics. It assigns a localhost port in 3000–3020 and stops the server after two hours. Use `devmetrics stop <port>` when finished. Rebuild the UI after changes and refresh the page to review them. Development and preview servers must also run through devmetrics.

On first launch the factory uses the **Simulated** driver against a demo repo it creates in `.factory/demo-repo`. Simulated agents make real commits, worktrees, merges and diffs, but they write harmless notes instead of code and make no API calls. Use it to learn the flow without spending tokens.

To put real agents on your own project, open **⚙ Settings** and:

1. Set **Repository path** to your git repo and **Base branch**.
2. Set the **Test**, **Coverage** and **Acceptance** commands for that project (see [Quality gates](#quality-gates)).
3. Optionally set a **Worktree setup command** (e.g. `npm ci`). Each worktree is a fresh checkout.
4. Switch **Driver** to **Claude Agent SDK**. It uses your Claude Code login or `ANTHROPIC_API_KEY`.

> ⚠️ Claude workers run with permission checks bypassed **inside their worktree**, so they can edit files and run your tests unattended. Only point the factory at repositories and tasks you trust. The planner, auditor and instruction writer are read-only.

## The stages

| Stage | Who acts | What happens |
|---|---|---|
| **Icebox** | You | Write the task in markdown. Type `#` to reference other cards; paste, drop or attach images. Press **Generate instructions** to see how the agents read it. If they misread it, improve the description and regenerate until you agree. Saving keeps both texts and parks the card here. Agents never start Icebox cards. |
| **Backlog** | You → coordinator | Drag cards in. Order is priority, top first. Cards can't be edited here, but can be dragged back (or aborted). When there is capacity, the coordinator takes the top card. It skips cards that reference a card still in flight, to avoid conflicting edits. It then creates the card worktree, splits the task into measurable subtasks with dependencies, and moves the card to the top of In Progress. |
| **In Progress** | Workers | Each subtask runs in its own worktree, branched from the card's worktree. Subtasks run in parallel once their dependencies are done, up to the worker limit. Workers log constantly. When a worker finishes, the coordinator commits its work and merges it into the card branch. A merge conflict becomes a *merge* subtask, and a failed subtask is retried once. |
| **Verification** | Coordinator + senior | Runs the tests, then coverage (target 90%, minimum 80% by default), then one senior audit pass per configured focus: complexity, structure, docs and best practices. Failing tests, low coverage, or "must"/"should" findings create fix subtasks and send the card back to In Progress. Nits are logged but don't block. |
| **Acceptance** | Worker + coordinator | A worker writes acceptance scripts under `acceptance/card-<id>/<journey>/<use-case>`, covering visual checks and a mobile viewport. The coordinator then runs your acceptance command. Failures send the card back to In Progress. On a pass, the coordinator decides whether a human must look: Deliverables if so, Complete otherwise. |
| **Deliverables** | You ⇄ coordinator | Cards waiting on you: **approval**, **input** (a credential, permission or decision a worker asked for), or **help** (repeated failures or errors). Reply in the thread and the coordinator answers, pushing back on unclear or risky input. Secrets you add are injected as environment variables and never shown again. Use **Approve**, **Request changes** or **Resume**. |
| **Complete** | — | Done. Visible for 7 days (configurable) or until hidden. **Follow-up card** opens a new card that references this one. With *Merge into base branch* on, the card branch is merged, but only if your main checkout is on the base branch and clean. |

**Abort** (from any stage past the Icebox) stops running agents and kills their processes. It removes the worktrees, renames the branches to `factory/archive/…`, and returns the card to the Icebox, where it is editable again.

The coordinator sends a card back at most **Max loops** times (5 by default). After that it escalates to you in Deliverables instead of looping forever.

## Logs

Every subtask records activity, shown in three views:

- **Team Chat**: summaries in named agent bubbles, with coordinator messages on the right and workers and senior auditors on the left. Expand a message to see recorded reasoning, test output, and audit findings. Detail-only output is preserved.
- **Logs**: a live activity feed. Real agents report through a `log_activity` tool and each tool call is captured, e.g. `Edited src/cart.ts` or `$ npm test`.
- **Diffs**: the subtask's exact changes since it forked, split per file.

The card's **Activity** tab defaults to **Team Chat**, followed by **Logs** and **Diffs**, without counters. The views are filterable by agent. Agent labels use stable name colors from the [approved light/dark palette](docs/agent-colors.md). Names such as Grace Hopper, Linus Torvalds, and Casey are example display profiles that help explain the team; each message remains the recorded output of its actual agent run. Stored IDs stay unchanged.

| Displayed job | Chat context |
|---|---|
| **Coordinator** | The current card, plan, dependencies, and repository; assigns tasks, tracks progress, and prepares handoffs. |
| **Designer** | An explicitly titled design, wireframe, mockup, or prototype task and its isolated worktree; reports layout and interaction decisions. |
| **Developer** | An implementation, fix, or merge task and its isolated worktree; reports code changes and blockers. |
| **Auditor** | A test task or acceptance-script subtask and its isolated worktree; reports scenarios, scripts, and findings. Recorded results establish what actually ran. |
| **Senior Developer** | The combined card worktree and current audit lens; reviews code and recommendations with read-only access. |

Job titles are display classifications of existing assignments. Designer and Auditor profiles use the existing worker driver and its subtask permissions; they do not introduce new driver roles. Each expanded Team Chat message shows its context and assigned task. **About the example agent profiles** explains all five jobs in the UI.

Card section tabs show a green dot for unread content. Opening a tab clears it; subsequent content changes mark it unread again while inactive. Read receipts are saved per card in this browser.

The **Thread** editor stays below the scrolling conversation and uses the same Markdown editor as card creation, with Write/Preview, card references, and image attachments.

The **Thread** tab includes review instructions: what changed, how to view the result, recorded checks, and limitations. Preview URLs and test access appear when available; missing details are called out. These notes are saved before worktrees are removed. Older cards get a summary from recorded activity.

You can talk to the coordinator from any card past the Icebox, including completed cards. General questions stay in the thread. A clear development request creates a linked **Icebox** card with the requested task; unclear requests get a question before a card is created. Chat never queues new work. Review and generate instructions, then use **Move to Backlog** to start it. The existing **Approve**, **Request changes**, and **Resume** controls still act on a card waiting in Deliverables.

The terminal button beside Settings opens **Background processes**. It lists devmetrics-managed servers for this app and its target repository, with URLs, PIDs, scheduled stop times, and a Stop control. Stopping the factory API disconnects the app. Unregistered OS processes are not listed or stopped by this control.

## Quality gates

| Setting | Example |
|---|---|
| Test command | `npm test`, `pytest`, `go test ./...` |
| Coverage command | `npx vitest run --coverage --coverage.reporter=json-summary --coverage.reporter=text`, `node --test --experimental-test-coverage`, `pytest --cov`, `go test -cover ./...` |
| Acceptance command | `npx playwright test acceptance/card-{card}` (`{card}` is the card id) |

Coverage is read from `coverage/coverage-summary.json` if your tool writes one. Otherwise it is parsed from the istanbul/c8/vitest/jest text table, `node --test`, pytest-cov or Go output. If no total is found, verification continues and logs a warning.

Leave a command empty to skip that gate.

## How it is built

```
server/
  index.ts          entry: DB, settings, drivers, coordinator, HTTP
  coordinator.ts    the state machine: scheduling, worker slots, loops, escalation, abort
  agents/driver.ts  the interface the coordinator talks to
  agents/claude.ts  Claude Agent SDK driver: query() per role, structured output, in-process MCP tools
  agents/simulated.ts  token-free driver for demos and tests
  prompts.ts        system prompts, prompt builders and JSON schemas per role
  git.ts            worktrees, commits, diffs, merges, archiving
  coverage.ts       coverage parsing and thresholds
  db.ts             SQLite (node:sqlite) persistence; every change is broadcast
  app.ts            REST API + server-sent events; manual-move rules live here
web/src/            React UI: board, card editor, card panel, logs, thread, settings
test/               node:test unit + end-to-end tests (simulated driver, real git)
e2e/                Playwright acceptance tests by journey/use case, desktop + mobile
```

- **Node 24+** (developed on 26). TypeScript runs directly through Node's type stripping, with no build step for the server.
- State lives in `.factory/` (database, uploads, worktrees). Set `FACTORY_DATA` to move it and `PORT` to change the port.
- Each agent call is a separate Agent SDK session with the right working directory and tool permissions: the planner and auditor are read-only; workers get `log_activity` and `request_human_input` tools.
- The default model is `claude-opus-5-5` for every role, configurable per role in Settings.

## Tests

```bash
npm test            # unit + full pipeline over the API with the simulated driver
npm run test:e2e    # Playwright: authoring, delivery, human hand-off, abort; desktop + mobile
npm run typecheck
```
