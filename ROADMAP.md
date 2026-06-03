# kimi-code Gap Analysis & Roadmap

> Based on deep-dive of current architecture + competitor research (Claude Code, Aider, Roo Code, Cursor, Codex CLI, IOSM CLI, etc.)

---

## Current Architecture Summary

### What kimi-code already has
- **Plan Mode**: Markdown file-based planning with user approval workflow
- **Context Compaction**: Full compaction (LLM summary) + Micro compaction (tool result truncation)
- **Session Persistence**: Wire record replay, metadata store, resume/fork/export
- **Subagents**: Profile-based sequential spawning with summary handoff
- **Goals**: Active/paused/blocked lifecycle with budget tracking
- **TodoList Tool**: Ephemeral task list in tool store
- **Skills**: File-based skill activation
- **MCP**: Full MCP client support
- **Hooks**: Pre/Post event system
- **Background Tasks**: Async task execution

### Critical Gaps

---

## 1. Continuous Plan Tracker (IN PROGRESS)

**Problem**: After context compaction, the LLM loses sight of the approved plan. The plan markdown file exists on disk but is NOT automatically re-injected into context. The TodoList tool store IS appended to compaction summaries, but plans are not.

**Competitor equivalents**:
- **AiderDesk**: `.aider-desk/tasks/{taskId}/todos.json` — persistent hierarchical tasks
- **Coding-Aider**: `.coding-aider-plans/feature.md` + `feature_checklist.md` + `feature_context.yaml`
- **Claude Code**: Skills + subagent framework with shared task context
- **IOSM CLI**: Structured methodology with persistent task trees

**Solution implemented**:
- `PlanTracker` class: file-backed structured task state (`plan-tracker.json`)
- `PlanTrackerInjector`: injects plan summary after compaction and periodically
- `PlanTrackerTool`: LLM updates task status, adds/removes tasks, sets current task
- Integrated into `FullCompaction.postProcessSummary` so plan survives compaction
- Auto-parses approved plan markdown into structured tasks on `ExitPlanMode`

---

## 2. Checkpoint / Rollback System

**Problem**: No way to instantly revert file changes. If the agent makes a bad edit, user must manually undo or use git.

**Competitor equivalents**:
- **Claude Code**: `Esc-Esc` instant rollback to previous checkpoint
- **Cursor**: "Restore Checkpoint" UI button
- **IOSM CLI**: Structured checkpoint + `/rollback` workflow
- **Aider**: Git-native — every change is a commit, `/undo` reverts last commit

**Proposed solution**:
- Automatic git commits before each tool execution batch
- Or: file-level snapshots in `~/.kimi-code/checkpoints/{sessionId}/`
- CLI command: `/checkpoint` to save, `/rollback` to restore
- Integrate with the existing permission system

---

## 3. Repo Map

**Problem**: Agent has no structural understanding of the codebase. It must read files individually or use Glob/Grep. Large codebases are expensive to explore.

**Competitor equivalents**:
- **Aider**: Auto-builds repo map (file names, top-level functions/classes, signatures, imports) with configurable token budget
- **Claude Code**: Agentic codebase search with 1M context window
- **Cursor**: IDE-native code intelligence

**Proposed solution**:
- Background repo map generation (AST parsing or ctags)
- Store in session directory, refresh on file changes
- Inject summary into context or provide as tool (`GetRepoMap`)

---

## 4. Architect / Editor Split

**Problem**: Single model does both planning and implementation. Complex refactors benefit from separation of concerns.

**Competitor equivalents**:
- **Aider**: `--architect` flag — architect model designs, editor model implements
- **Roo Code**: Multi-mode system (Code, Architect, Ask, Debug)
- **Claude Code**: Subagent framework with specialized roles

**Proposed solution**:
- Multi-model configuration: `architect_model` vs `editor_model`
- Plan mode uses architect model, execution uses editor model
- Or: subagent-based architect mode

---

## 5. Parallel Subagent Orchestration

**Problem**: Subagents run sequentially. No task queue, dependency DAG, or worktree isolation.

**Competitor equivalents**:
- **Claude Code**: Agent Teams with shared task list, tmux-based coordination
- **IOSM CLI**: Dependency DAGs, file locks, worktree isolation
- **kimi-code upstream**: 100-agent swarm capability (Moonshot's claim)

**Proposed solution**:
- Task queue with dependency resolution
- Worktree-based isolation for parallel subagents
- Parent agent coordinates via shared plan tracker

---

## 6. Persistent Cross-Session Memory

**Problem**: No accumulation of project knowledge across sessions. Each session starts fresh.

**Competitor equivalents**:
- **Claude Code**: `CLAUDE.md` — 4-tier hierarchy (Enterprise, Project, User, Local)
- **Aider**: `CONVENTIONS.md` support
- **gitnu**: `.claude/skills/gitnu/SKILL.md` — cognitive state versioning

**Proposed solution**:
- Auto-generate and update `.kimi-code/memory.md` or `KIMI.md`
- Store learnings, conventions, decisions, common patterns
- Inject into system prompt context

---

## 7. Git-Native Workflows

**Problem**: No automatic git integration. Changes are not tracked unless user manually commits.

**Competitor equivalents**:
- **Aider**: Auto-commits every change, clean commit history, `/undo` reverts
- **Cursor**: Git integration in IDE
- **Claude Code**: File-history checkpoints

**Proposed solution**:
- Configurable auto-commit before/after each turn
- Branch-per-task workflow
- Git status injection into context

---

## 8. Test / Lint Integration

**Problem**: No built-in test running or linting. Agent can't validate its own work.

**Competitor equivalents**:
- **Aider**: `/test <cmd>`, `/lint <cmd>` — runs tests/lint and auto-fixes failures
- **Claude Code**: Shell command execution with result interpretation
- **Cursor**: Background cloud agents run tests

**Proposed solution**:
- Auto-detect test runners (jest, pytest, cargo test, etc.)
- Run tests after file edits, report failures to LLM
- Similar for lint/typecheck

---

## 9. Cost Tracking

**Problem**: No per-session or per-task cost awareness.

**Competitor equivalents**:
- **AiderDesk**: Per-task cost tracking, real-time updates
- **Claude Code**: Usage tracking via telemetry
- **IOSM CLI**: Per-call cost tracking

**Proposed solution**:
- Expose usage data in TUI
- Per-plan-tracker cost attribution
- Budget alerts

---

## 10. Browser / Preview Control

**Problem**: No way to preview frontend changes or interact with web apps.

**Competitor equivalents**:
- **Claude Code**: "Claude in Chrome" — browser control, screenshot, interaction
- **Cursor**: IDE-integrated preview
- **Aider**: None (terminal-only limitation)

**Proposed solution**:
- MCP-based browser control (Playwright MCP)
- Screenshot + interaction tools
- Preview server detection

---

## Priority Ranking

| Priority | Feature | Impact | Effort | Status |
|----------|---------|--------|--------|--------|
| P0 | Continuous Plan Tracker | Critical | Medium | **DONE** |
| P1 | Checkpoint / Rollback | High | Medium | Not started |
| P1 | Test/Lint Integration | High | Low | Not started |
| P2 | Repo Map | High | High | Not started |
| P2 | Git-Native Workflows | High | Medium | Not started |
| P2 | Persistent Memory | High | Low | Not started |
| P3 | Architect/Editor Split | Medium | High | Not started |
| P3 | Parallel Subagents | Medium | High | Not started |
| P3 | Cost Tracking | Low | Low | Not started |
| P4 | Browser Control | Medium | High | Not started |

---

## Implementation Notes

### Plan Tracker (DONE)
Files added/modified:
- `packages/agent-core/src/agent/plan/tracker.ts` — new
- `packages/agent-core/src/agent/injection/plan-tracker.ts` — new
- `packages/agent-core/src/tools/builtin/planning/plan-tracker.ts` — new
- `packages/agent-core/src/agent/index.ts` — add planTracker field
- `packages/agent-core/src/agent/injection/manager.ts` — register injector
- `packages/agent-core/src/agent/compaction/full.ts` — append to summary
- `packages/agent-core/src/tools/builtin/planning/exit-plan-mode.ts` — init tracker
- `packages/agent-core/src/agent/tool/index.ts` — register tool
- `packages/agent-core/src/tools/builtin/index.ts` — export tool
- `packages/agent-core/src/agent/plan/index.ts` — clear on enter/cancel
- `apps/kimi-code/src/cli/options.ts` — make agentFile/mcpConfigFile optional
