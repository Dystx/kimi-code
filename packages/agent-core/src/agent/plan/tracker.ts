import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'pathe';

import type { Agent } from '..';

export type PlanTaskStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped';

export interface PlanTask {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly status: PlanTaskStatus;
  readonly dependencies?: readonly string[];
}

export interface PlanTrackerData {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly createdAt: string;
  readonly tasks: readonly PlanTask[];
  readonly currentTaskId?: string;
}

/**
 * PlanTracker — durable structured plan state that survives context compaction.
 *
 * When plan mode exits with an approved plan, the tracker is initialized from
 * the plan markdown. It stores structured tasks on disk (in the agent homedir)
 * and provides a text summary that can be injected into context after
 * compaction or periodically during execution.
 *
 * Unlike the ephemeral TodoList tool store, PlanTracker state is file-backed
 * and explicitly appended to compaction summaries so the LLM never loses
 * sight of the overall plan.
 */
export class PlanTracker {
  private _data: PlanTrackerData | null = null;

  constructor(
    private readonly agent: Agent,
    private readonly filePath: string,
  ) {}

  get data(): PlanTrackerData | null {
    return this._data;
  }

  get isActive(): boolean {
    return this._data !== null;
  }

  get currentTask(): PlanTask | undefined {
    if (this._data?.currentTaskId === undefined) return undefined;
    return this._data.tasks.find((t) => t.id === this._data!.currentTaskId);
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as PlanTrackerData;
      if (isValidPlanTrackerData(parsed)) {
        this._data = parsed;
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'ENOENT') {
        this.agent.log.warn('plan-tracker load failed', { error });
      }
    }
  }

  async save(): Promise<void> {
    if (this._data === null) return;
    try {
      await writeFile(this.filePath, JSON.stringify(this._data, null, 2), 'utf-8');
    } catch (error) {
      this.agent.log.warn('plan-tracker save failed', { error });
    }
  }

  /**
   * Initialize the tracker from an approved plan markdown string.
   * Heuristic: looks for markdown task lists (`- [ ] task`) and headings
   * to build structured tasks.
   */
  async initializeFromPlan(planText: string, title: string): Promise<void> {
    const tasks = parsePlanMarkdown(planText);
    this._data = {
      id: `plan_${randomUUID()}`,
      title: title || 'Approved Plan',
      createdAt: new Date().toISOString(),
      tasks,
      currentTaskId: tasks.find((t) => t.status === 'pending')?.id,
    };
    await this.save();
  }

  /**
   * Clear the tracker (called when a plan is cancelled or a new plan replaces
   * the old one).
   */
  async clear(): Promise<void> {
    this._data = null;
    try {
      await writeFile(this.filePath, '{}', 'utf-8');
    } catch {
      // Best-effort clear.
    }
  }

  updateTaskStatus(taskId: string, status: PlanTaskStatus): void {
    if (this._data === null) return;
    const task = this._data.tasks.find((t) => t.id === taskId);
    if (task === undefined) return;

    const updatedTasks = this._data.tasks.map((t) =>
      t.id === taskId ? { ...t, status } : t,
    );
    this._data = { ...this._data, tasks: updatedTasks };

    // Auto-advance current task when a task is marked done.
    if (status === 'done' && this._data.currentTaskId === taskId) {
      const next = findNextPendingTask(updatedTasks);
      this._data = { ...this._data, currentTaskId: next?.id };
    }
  }

  addTask(task: Omit<PlanTask, 'id'>): string {
    if (this._data === null) throw new Error('PlanTracker is not active');
    const id = `task_${randomUUID()}`;
    const newTask: PlanTask = { ...task, id };
    this._data = {
      ...this._data,
      tasks: [...this._data.tasks, newTask],
    };
    return id;
  }

  removeTask(taskId: string): void {
    if (this._data === null) return;
    this._data = {
      ...this._data,
      tasks: this._data.tasks.filter((t) => t.id !== taskId),
      currentTaskId:
        this._data.currentTaskId === taskId
          ? undefined
          : this._data.currentTaskId,
    };
  }

  setCurrentTask(taskId: string): void {
    if (this._data === null) return;
    if (!this._data.tasks.some((t) => t.id === taskId)) return;
    this._data = { ...this._data, currentTaskId: taskId };
  }

  /**
   * Produce a concise text summary suitable for context injection or
   * compaction summary post-processing.
   */
  getSummaryText(): string {
    if (this._data === null) return '';
    const lines: string[] = [];
    lines.push(`## Plan: ${this._data.title}`);

    const { tasks, currentTaskId } = this._data;
    const pending = tasks.filter((t) => t.status === 'pending').length;
    const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
    const done = tasks.filter((t) => t.status === 'done').length;
    const blocked = tasks.filter((t) => t.status === 'blocked').length;

    lines.push(
      `Progress: ${done}/${tasks.length} done` +
        (inProgress > 0 ? `, ${inProgress} in progress` : '') +
        (blocked > 0 ? `, ${blocked} blocked` : '') +
        (pending > 0 ? `, ${pending} pending` : ''),
    );

    if (currentTaskId !== undefined) {
      const current = tasks.find((t) => t.id === currentTaskId);
      if (current !== undefined) {
        lines.push(`\nCurrent task: [${current.status}] ${current.title}`);
        if (current.description) {
          lines.push(current.description);
        }
      }
    }

    const remaining = tasks.filter(
      (t) => t.status === 'pending' || t.status === 'in_progress' || t.status === 'blocked',
    );
    if (remaining.length > 0) {
      lines.push('\nRemaining tasks:');
      for (const task of remaining) {
        const depNote =
          task.dependencies && task.dependencies.length > 0
            ? ` (depends on: ${task.dependencies.join(', ')})`
            : '';
        lines.push(`  - [${task.status}] ${task.title}${depNote}`);
      }
    }

    return lines.join('\n');
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function isValidPlanTrackerData(value: unknown): value is PlanTrackerData {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['title'] === 'string' &&
    Array.isArray(v['tasks'])
  );
}

/**
 * Heuristic parser for plan markdown.
 * Recognises:
 *   - GitHub-style task lists: `- [ ] title`, `- [x] title`
 *   - Numbered tasks: `1. [ ] title`, `1. [x] title`
 *   - Plain list items that look like tasks: `- title`
 *
 * Headings (## / ###) are treated as task group titles prefixed to the
 * following tasks' descriptions.
 */
function parsePlanMarkdown(text: string): PlanTask[] {
  const tasks: PlanTask[] = [];
  const lines = text.split('\n');
  let currentHeading = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    if (/^#{2,4}\s+/.test(line)) {
      currentHeading = line.replace(/^#{2,4}\s+/, '').trim();
      continue;
    }

    const taskMatch = line.match(/^(?:[-*]|\d+\.)\s+\[([ xX~])\]\s+(.*)$/);
    if (taskMatch) {
      const check = taskMatch[1]!.toLowerCase();
      const title = taskMatch[2]!.trim();
      const status: PlanTaskStatus =
        check === 'x' ? 'done' : check === '~' ? 'skipped' : 'pending';
      const description = currentHeading ? `Group: ${currentHeading}` : undefined;
      tasks.push({
        id: `task_${randomUUID()}`,
        title,
        description,
        status,
      });
      continue;
    }

    // Fallback: plain list item that isn't a task list
    const plainMatch = line.match(/^(?:[-*]|\d+\.)\s+(.*)$/);
    if (plainMatch && !line.includes('[')) {
      const title = plainMatch[1]!.trim();
      if (title.length > 0 && title.length < 200) {
        const description = currentHeading ? `Group: ${currentHeading}` : undefined;
        tasks.push({
          id: `task_${randomUUID()}`,
          title,
          description,
          status: 'pending',
        });
      }
    }
  }

  return tasks;
}

function findNextPendingTask(tasks: readonly PlanTask[]): PlanTask | undefined {
  for (const task of tasks) {
    if (task.status === 'pending') {
      // Check dependencies are satisfied
      if (task.dependencies && task.dependencies.length > 0) {
        const allDone = task.dependencies.every((depId) =>
          tasks.some((t) => t.id === depId && (t.status === 'done' || t.status === 'skipped')),
        );
        if (!allDone) continue;
      }
      return task;
    }
  }
  return undefined;
}

export function planTrackerPath(homedir: string | undefined): string | undefined {
  if (homedir === undefined) return undefined;
  return join(homedir, 'plan-tracker.json');
}
