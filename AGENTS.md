# AGENTS.md

Instructions for coding agents working on this repository. Read `CONTEXT.md` first for what the product is and why it works the way it does.

## Commands

```bash
npm install
npm run dev          # API (node --watch) on :4400 + Vite UI on :5173
npm run typecheck    # tsc over server, web, tests
npm test             # node:test — unit + full pipeline with the simulated driver
npm run test:e2e     # Playwright (builds first) — desktop + mobile projects
npm run build && npm start
```

Before you finish a change, run `npm run typecheck` and `npm test`. If you touched anything under `web/` or the API, also run `npm run test:e2e`.

## Layout

| Path | Responsibility |
|---|---|
| `server/types.ts` | Domain types shared with the client. No Node imports here. |
| `server/db.ts` | SQLite via `node:sqlite`. **Every mutation emits a `FactoryEvent`.** Also versions, backs up and migrates the schema. |
| `server/crypto.ts` | AES-256-GCM sealing for card secrets, with the key in `secret.key` (or `FACTORY_SECRET_KEY`). |
| `server/transfer.ts` | Export and import of the setup: skills, agents, projects (never cards or secrets). |
| `server/settings.ts` | Per-project settings (cached, defaults merged), model lists and provider defaults. |
| `server/factory.ts` | One coordinator per project; routes card work to the card's coordinator. |
| `server/profiles.ts` | Agent profiles, the skills library and per-profile plugin folders, team assignment (`pickProfile`, `needsFor`). |
| `server/providers.ts` | Agent CLIs on this machine (detection, on/off) and `assertUsable` for every driver choice. |
| `server/skill-import.ts` | Importing skills from GitHub and skills.sh (shallow clone, then scan for SKILL.md). |
| `server/errors.ts` | `HttpError`. |
| `server/auth.ts` | The API guard: loopback hosts only, no other origins, and the per-install token written into `index.html`. |
| `server/coordinator.ts` | The state machine for one project. The only code that moves cards past the Backlog. |
| `server/assistant.ts` | The cross-project assistant: validates and performs its actions, posts notifications and relays. |
| `server/app.ts` | REST + SSE. The rules for manual moves (Icebox ⇄ Backlog) live here. |
| `server/agents/driver.ts` | The interface between the coordinator and an "intelligence" backend. |
| `server/agents/claude.ts` | Claude Agent SDK driver. |
| `server/agents/simulated.ts` | Deterministic, token-free driver for demos and tests. |
| `server/agents/cli.ts` | Codex, OpenCode and Pi drivers: one CLI run per role, access enforced by the CLI, events parsed into logs and usage. |
| `server/agents/simulated-assistant.ts` | The simulated assistant: a pure, deterministic reading of everyday phrasing. Unit-tested in `test/unit.test.ts`. |
| `server/prompts.ts` | All prompts, plus the JSON schemas used for structured output. |
| `server/git.ts`, `shell.ts`, `coverage.ts` | Worktrees, child processes, coverage parsing. |
| `web/src/` | React 19 UI. `store.ts` holds the live state, fed by SSE. `App.tsx` routes home ⇄ boards by URL hash. |
| `test/` | node:test suites. `factory.test.ts` drives real git through the HTTP API. |
| `e2e/<journey>/<use-case>.spec.ts` | Playwright acceptance tests. |

## Conventions

- **TypeScript runs natively in Node (type stripping).** There is no server build step, so:
  - use only erasable syntax: no `enum`, no `namespace`, no constructor parameter properties;
  - import local files with the `.ts` extension;
  - use `import type` for type-only imports (`verbatimModuleSyntax` is on).
- **Stage transitions:**
  - Only the coordinator moves cards into In Progress, Verification, Acceptance, Deliverables or Complete.
  - Users can only move cards Icebox ⇄ Backlog, reorder within those two, abort, and act in Deliverables.
  - The assistant acts for the user only on an explicit request, through the same coordinator methods and checks (`Coordinator.enqueue`, `approve`, …). Its thread messages carry `via: 'assistant'`.
  - Enforce new rules on the server (`app.ts` / `coordinator.ts` / `assistant.ts`), not only in the UI.
- **New tasks always land in the Icebox.** Never queue a task as part of creating it. Only integration cards (merge, pull, push) are created in the Backlog, by the coordinator.
- **Every agent run is done by a profile.** Build contexts with `Coordinator.ctx(…, profile)` so logs carry `profileId` and usage is recorded; report usage from drivers through `ctx.usage`.
- **Everything card-related is project scoped.** Cards need a `projectId`; columns, positions and coordinators are per project. Read settings with `settings(projectId)`, never a global.
- **Persist through `db.ts`** so clients are notified. Don't write to SQLite anywhere else.
- **Long-running work takes an `AbortSignal` and respects it.**
  - Abort must stop agents and child processes, and must never leave a worker writing after the card has moved on.
  - Throw `AbortError` (or check `signal.aborted`) after every await that does real work.
- **New agent roles:**
  1. Add the method to `Driver`; it takes an `AgentContext` (profile, usage, log, signal).
  2. Implement it in **both** `claude.ts` and `simulated.ts`.
  3. Put the prompt and schema in `prompts.ts`.
  - Read-only roles use `readOnly: true`. Only workers get write access.
- **Keep the simulated driver deterministic.** Tests depend on its behavior:
  - the first audit pass raises one finding;
  - text mentioning credentials blocks the worker;
  - "review"/"approve" wording requires approval;
  - replies under three words get pushed back;
  - merge subtasks really run the `git merge` named in their instructions, keeping this card's side of conflicts;
  - every run reports estimated tokens at zero cost as model `simulated`, and workers log `Using skills: …`;
  - the assistant reads intents anywhere in a sentence, names projects by name or repository folder, and reads "it" as the card last shown. New-task requests always win over card actions, and questions never act. Add a unit test for any phrasing you teach it.
- **Secrets** go through `db.setSecrets` / `getSecrets` only; they're encrypted at rest. Never put secret values in logs, comments, events, exports or the `Card` sent to clients (only `secretNames`).
- **Schema changes:** add columns with `addColumn` in `openDb` (idempotent). A change that rewrites data goes in `MIGRATIONS` under a new `SCHEMA_VERSION`; the database is backed up before it runs, and a newer database is refused.
- **Models:** the default is `claude-opus-5-5`. Don't hardcode model IDs outside `settings.ts` (`CLAUDE_MODELS`).
- **Providers:** a new provider needs a driver (and recorded fixtures) before it joins `WORK_PROVIDERS`. Read-only roles must stay unable to write; `test/cli.test.ts` checks every CLI's flags. Validate every driver choice with `assertUsable`. Tests must not depend on which CLIs are installed.
- **Style:** match the surrounding code. Doc comments on modules and non-obvious functions, short comments only where the *why* isn't clear. No new dependencies without a good reason.

## Gotchas (each one has bitten us)

- **`useEffect` bodies must use braces.** Newer Chromium returns a Promise from `scrollIntoView()`. An expression-bodied effect hands that Promise to React as a cleanup, which crashes the subtree.
- **Node 26's `node --test` won't take a directory.** Use `node --test` or a glob like `'test/*.test.ts'`.
- **Child processes must not inherit `NODE_TEST_CONTEXT`**, or a nested `node --test` reports to the parent runner and prints nothing. `shell.run` already strips it.
- **The scheduler must skip cards being aborted** (`Coordinator.aborting`). Otherwise a tick can restart work mid-abort.
- **`complete()` moves the card before cleaning up worktrees.** Tests should wait for `worktree === null`, not just `stage === 'complete'`. A merge must not start meanwhile (`Coordinator.finishing`).
- **A merge in progress must always be committed**, even when the resolution leaves the files unchanged; otherwise the branch never contains the base and the merge loops. `commitAll` handles this.
- **Only verified code reaches the base branch.** `publishToBase` refuses unless the card branch already contains the base; otherwise the integration card merges what's new and is re-verified first.
- **A merge card's branch is the finished card's branch**, not `factory/card-<id>`. Use `card.branch ?? cardBranch(card.id)`, never assume the name.
- **Child processes get a closed stdin** (`shell.run`). `codex exec` waits forever on an open one.
- **Express 5 has no inline regex route params** (`:kind(pull|push)`); validate params in the handler.
- **Network git in tests uses a local bare repository** as the remote; never a real one. Skill imports are tested with `importFromGit` on local repositories.
- **Design work is routed by job title**, not a role: `needsFor` asks for a worker and prefers titles matching /design/.
- **Playwright projects share one server and database**, including the one assistant conversation. Make test data unique per project (e.g. include `test.info().project.name`).
- **`/` is the home screen now.** Board specs start at `DEMO_BOARD` (`/#project-1`), the demo project every fresh factory creates.
- **Assistant notifications are deferred one tick** so the coordinator's question, posted right after a card moves, is included. Tests should poll for them.
- **Every API call needs the install's token.** The UI reads it from the page (`API_TOKEN` in `web/src/api.ts`); add `AUTH` to any new `fetch`. Server tests pass it to `createApp`; e2e specs import `test` from `e2e/helpers.ts` so `request` carries it. Node's `fetch` ignores a custom `Host` header; use `node:http` to test one.
- **HTML5 drag & drop doesn't work on touch.** Every drag action needs a button equivalent (e.g. "Move to Backlog").

## Testing guidance

- **Server behavior:** add to `test/factory.test.ts`, using the HTTP API with `FACTORY_SIM_SPEED=0`.
- **UI behavior:** add a spec under `e2e/<journey>/`. Prefer role/label locators. Check that the page doesn't scroll horizontally on mobile (`expectNoHorizontalOverflow`).
- **Real drivers:** don't add automated tests that call Claude or the agent CLIs; they cost money. Smoke-test manually with a cheap model in a throwaway repo if you change `claude.ts` or `cli.ts`, and start CLIs inside that repo (Pi has no folder flag).
- **CLI parsers are tested on recorded output** in `test/fixtures/providers/`. When a CLI's format changes, record a new fixture from a throwaway repo rather than guessing.

## Don'ts

- Don't commit `.factory/` (database, uploads, worktrees), `dist/` or `test-results/`.
- Don't loosen worker permissions beyond their worktree, and don't give the planner or auditor write tools.
- Don't let the coordinator loop forever. Anything retried must count toward `maxLoops` or `MAX_SUBTASK_ATTEMPTS` and escalate to Deliverables.
