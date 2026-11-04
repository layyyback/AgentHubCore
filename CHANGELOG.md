# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-01

### Added

- `hub wait <run> [<run> ...]`: wait for a batch of runs; exit 0 when all completed, 1 when some failed or were canceled, 2 when some are still running after `--timeout` (default 100 seconds).
- `hub run --worktree-of <run>`: another role continues on a finished run's worktree and branch (for example QA checking a Dev branch); runs sharing a worktree are serial.
- Role memory in the hub: `hub memory add` and `hub memory list` write and read `<hub>/agents/<role>/memory.md`, one dated line per rule, after a personal-data check (exit 3 when refused). Every dispatch reads the role's hub memory by absolute path, so it applies in every project and in worktrees.
- Roles end their final answer with `## Memory proposals` instead of editing memory; the GM relays them and records only what the user approves.
- GM card: planning serial versus parallel work, collecting a batch with `hub wait`, and recording confirmed corrections.
- `npm run parallel-check`: measures how many runs a machine carries at once, with fake runners by default or real CLIs with `--real --yes`.

### Changed

- Home pages start from the problem they solve, with seven highlights in plain language, a "How a request becomes a batch of runs" section and diagram, and the technical description moved to "What it is".
- The Quick start waits with `hub wait` instead of a shell loop.
- Inside a hub (its root or any directory below it) every `hub` command except `hub init` finds the hub by itself when `--hub` is left out, by walking up to the `AGENTS.md` that carries the hub entry block.
- GM card: the summary table is given in the conversation and must include an open-questions column; open questions, blockers, and memory proposals are relayed one by one in the conversation, and writing them only into a file does not count.
- `hub memory add` requires `--confirmed`, to be added only after the user explicitly approved the line in a later reply; without it the command exits 1 and writes nothing. A `--project` given as a path is recorded by its directory name only.
- GM card: showing the plan summary is step 1, before any `hub run`; a memory rule is recorded only after the user's explicit yes in a later reply; a line refused by the privacy check is reworded by the user, never by the GM.
- Known limitations: a Codex GM cannot dispatch roles that run on Codex (a nested `codex exec` cannot start inside Codex's default sandbox); set those roles to `runner: claude-code`, use a Claude GM, or run `hub run` from a normal terminal.
- The GM card requires sending the plan summary as text before the first `hub run`, also in one-shot sessions, and calling `hub` without environment-variable prefixes so permission rules match.
- The GM no longer runs `git`: it reads project state from `hub report`, `hub worktree list`, and `hub board`, and hands `git log` / `git merge` commands to the user, so Claude Code only needs `Bash(hub:*)`. When a report has no open questions the GM must say so explicitly, in its own words, never as "no blockers".
- The memory highlight says models read memory on every run but only `hub memory add` writes it after you confirm, and a new known limitation says roles not editing memory is a rule, not enforcement.
- `hub install` ends with a note about project-level role memory.
- Personal-data rules moved to `src/private-rules.mjs`, shared by `npm run scan` and `hub memory add`.

### Fixed

- A runner that exited while its run record was still being written could leave the run stuck in `running` with an empty log (seen on Linux CI). Runner output and exit listeners are now attached before anything is awaited, and a runner that cannot be started marks the run `failed`.

## [0.2.0] - 2026-10-30

### Changed

- Role cards are a single `agents/<role>/AGENTS.md` read by both Claude Code and Codex CLI. Each card starts with a generated-file header and an identity notice.
- `hub install` no longer writes `CLAUDE.md`. A root `CLAUDE.md` that only contains `@AGENTS.md` is removed; custom ones are kept with a hint. Files the lock still tracks but the installer no longer generates are removed if untouched, kept and untracked if edited.
- The `--create` skeleton now says: read `docs/` first, write decisions back to `docs/`, change code only in the project or its isolated copy.
- The project collaboration block mentions `PROJECT.md` and the GM.
- `hub resume` refuses a parent run that is still active or has no captured native session, instead of silently starting a new conversation.

### Added

- GM entry: `hub init` writes a hub-root `AGENTS.md` entry block, `.project-root`, `.gitignore`, and seeds roles and the skill; the built-in `gm` role (`kind: entry`) needs no runner and cannot be dispatched.
- `agents/<role>/PROJECT.md`: project-owned requirements for a role, read after the role card on every dispatch.
- `hub run --task-file <path>` and three fixed working-discipline lines at the end of every dispatch prompt.
- `hub install --roles a,b` to install a subset of roles.
- `hub board`: read-only view of active and recent runs (status, elapsed time, last runner event); no percentages.
- `hub run --worktree` and `hub worktree list|prune`: one git worktree per run on branch `hub/<run>`, reused by `hub resume`, merged by the user. A warning is printed when the role card a worktree run needs is not committed, and when another run is active in the same project without `--worktree`.
- The GM card requires reading the whole `hub report` after a run and relaying every open question, decision, and blocker one by one, or saying explicitly that there are none; it must not answer them for the user.
- The GM card dispatches each new request as a new run and resumes a run only when the user is clearly answering that role's earlier question; when unsure it asks.
- `hub --help`, `hub -h`, and `hub <command> --help` print usage and exit 0.
- The Quick start waits for runs with a 10-minute limit and points to `hub status` on timeout.
- `bin/hub`, so the Quick start can put `hub` on `PATH` (`export PATH="$PWD/bin:$PATH"`) where GM sessions can call it; the home pages explain how to allow `Bash(hub:*)` in Claude Code.
- English (`README.md`) and Chinese (`README.zh-CN.md`) home pages with architecture and flow diagrams.
- MIT license, GitHub Actions CI (Node 20 and 22), and `npm run scan`, a personal-data scan over tracked files.

### Fixed

- Runs keep the parent's `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` group together. Previously the `KEY` entries were dropped as if they were credentials, so every git command inside a run exited 128 when the parent session set them.

### Removed

- Generated `CLAUDE.md` copies of role cards.
- `examples/hub`; use `hub init` to create a hub.

## [0.1.0] - 2026-10-14

### Added

- One Markdown role source per role, generated into native instruction cards.
- In-place project install with a fingerprint lock, `hub check` (`ok` / `modified` / `missing`), `hub diff`, and zero writes on repeat.
- Background runs for Claude Code and Codex CLI with `status`, `report`, `resume` into the same native session, and `cancel`.
- Change snapshots for git and non-git projects, including files that were already dirty before the run.
