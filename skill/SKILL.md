---
name: agenthub
description: Delegate bounded work to local PM, development, and QA roles through AgentHub Core.
---

# AgentHub collaboration

Use the hub path recorded in `.agenthub/project.json`. A project is always explicit. Inside the hub itself (its root or any directory below it) `--hub` may be left out; `hub` finds the hub by the entry block in its `AGENTS.md`.

1. Dispatch: `hub run --hub <hub> --project <project> --role <role> --task "<clear task and acceptance criteria>"`. For long tasks write them to a file and pass `--task-file <path>` instead.
2. Follow progress: `hub status --hub <hub> [<run>]`. To wait for one or more runs, use `hub wait --hub <hub> <run> [<run> ...]` (exit 0 all completed, 1 some failed or canceled, 2 still running: call it again); do not poll with shell loops.
3. Read the result and exact file changes: `hub report --hub <hub> <run>`.
4. Continue the same native conversation: `hub resume --hub <hub> <run> --task "<follow-up>"`.
5. Stop active work: `hub cancel --hub <hub> <run>`.
6. Parallel work in a git project: add `--worktree` to `hub run`. The run works in `<project>-wt/<run>` on branch `hub/<run>`; `hub resume` keeps using it. A different role can continue on that branch after the run finishes with `hub run --worktree-of <run>` (for example QA checking a Dev branch). The user merges the branch; `hub worktree prune --hub <hub>` removes finished worktrees and keeps the branches.
7. Lasting rules for a role: `hub memory add --hub <hub> --role <role> --text "<one line>" --confirmed` (add `--confirmed` only after the user explicitly approved that exact line in a later reply; never in the same turn you proposed it) records it in `<hub>/agents/<role>/memory.md` (not in git); every later run of that role reads it, in any project. `hub memory list` shows them. Roles propose new rules under `## Memory proposals` in their final answer; record only the ones the user approves.

A role reads its card at `agents/<role>/AGENTS.md`, then its hub memory, then the project's optional `agents/<role>/PROJECT.md` and `agents/<role>/memory.md`. A run that completed is not work that was accepted; bring the report's open questions back to the user.

Runs are local background processes, not remote jobs. Check a report before relying on its output. If change collection reports an error, state that the artifact list may be incomplete.

## Reporting progress

Run `hub board --hub <hub>` and report from it:

- First sentence: how many runs are active, how many just finished, and whether anything needs the user.
- Then one line per run, grouped by project.
- For a `failed` run, read `hub report` and state the one step the user has to take.
- Never give percentages, and never call a reported "done" merged or released.
