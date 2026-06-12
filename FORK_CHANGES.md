# Fork Changes

This document tracks user-facing changes in this fork that diverge from upstream Kimi Code.

## Removed TUI commands and panels

To reduce UI clutter and consolidate status display into the footer, the following standalone commands and dialogs were removed:

- **`/cost` slash command** — previously opened a detailed cost/budget breakdown panel in the transcript.
- **`/status` slash command** — previously opened a full session status panel with filters for `tasks`, `cost`, `health`, and `all`.
- **`OrchestrationPanel` dialog** — previously opened a full-screen live view of the plan tracker, active subagents, hooks, health metrics, and background tasks.

### Migration

The same information is now surfaced through the footer chrome:

- Live model, cost, context, and loop state appear in the footer status line.
- Background bash/agent work is shown as `[N shell(s) running]` / `[N agent(s) running]` badges.
- Git branch, dirty state, ahead/behind, diff stats, and PR info are shown in the footer git badge.
- Plan tasks and subagent counts are rendered directly in the footer.

## Other notable changes

- Git status reads are now async and TTL-cached so the footer never blocks on `git` or `gh` calls.
- Agent tool and profile prompt sources use `?raw` imports so they are bundled into `dist/`.
- ACP session replay and error handling have been hardened.
- The skill scanner now also looks at `~/.kimi/skills/` as a legacy user skill root, so skills are not silently ignored if they live there instead of `~/.kimi-code/skills/`.
- Session startup now logs the resolved skill roots and total skill count for easier debugging.
