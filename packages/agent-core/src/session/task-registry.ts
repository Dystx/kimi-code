import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'pathe';
import type { OrchestrationHooks } from './orchestration-hooks';

/**
 * SessionTaskRegistry — shared task list with dependency tracking for
 * multi-agent coordination.
 *
 * Agents can create tasks, claim them, report completion/failure, and
 * query dependency status.
 */

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly assignee?: string;
  readonly status: TaskStatus;
  readonly dependencies: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly result?: string;
}

export interface TaskRegistrySnapshot {
  readonly tasks: readonly Task[];
  readonly total: number;
  readonly byStatus: Record<TaskStatus, number>;
}

export class SessionTaskRegistry {
  private tasks = new Map<string, Task>();
  private idCounter = 0;
  private pendingUnblockEmits: Array<{ taskId: string; title: string; assignee?: string }> = [];
  private hasActiveGoal = false;

  constructor(private readonly orchestrationHooks?: OrchestrationHooks) {}

  setGoalActive(active: boolean): void {
    this.hasActiveGoal = active;
  }

  create(
    title: string,
    options: {
      description?: string;
      assignee?: string;
      dependencies?: readonly string[];
    } = {},
  ): Task {
    const id = `task_${++this.idCounter}_${Date.now()}`;
    const deps = options.dependencies ?? [];
    const status = this.isBlocked(deps) ? 'blocked' : 'pending';
    const task: Task = {
      id,
      title,
      description: options.description,
      assignee: options.assignee,
      status,
      dependencies: deps,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.set(id, task);
    const unblocked = this.recomputeBlockedStatuses();

    this.orchestrationHooks?.emit({
      type: 'task.created',
      payload: {
        taskId: id,
        title,
        status,
        assignee: options.assignee,
        dependencyCount: deps.length,
        totalTaskCount: this.tasks.size,
        hasActiveGoal: this.hasActiveGoal,
      },
    });

    for (const unblockedId of unblocked) {
      const t = this.tasks.get(unblockedId);
      if (t !== undefined) {
        this.pendingUnblockEmits.push({
          taskId: unblockedId,
          title: t.title,
          assignee: t.assignee,
        });
      }
    }
    this.flushPendingUnblocks();

    return task;
  }

  update(
    id: string,
    updates: Partial<Pick<Task, 'title' | 'description' | 'assignee' | 'status' | 'result'>>,
  ): Task | undefined {
    const existing = this.tasks.get(id);
    if (existing === undefined) return undefined;

    const updated: Task = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    };
    this.tasks.set(id, updated);

    // If this task changed status, recompute blocked states for dependents
    if (updates.status !== undefined) {
      const unblocked = this.recomputeBlockedStatuses();

      if (updates.status === 'completed' || updates.status === 'failed') {
        this.orchestrationHooks?.emit({
          type: updates.status === 'completed' ? 'task.completed' : 'task.failed',
          payload: {
            taskId: id,
            title: updated.title,
            status: updates.status,
            result: updated.result,
            assignee: updated.assignee,
            dependencyCount: updated.dependencies.length,
          },
        });
      }

      for (const unblockedId of unblocked) {
        const t = this.tasks.get(unblockedId);
        if (t !== undefined) {
          this.pendingUnblockEmits.push({
            taskId: unblockedId,
            title: t.title,
            assignee: t.assignee,
          });
        }
      }
      this.flushPendingUnblocks();
    }

    return updated;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  list(filter?: { status?: TaskStatus; assignee?: string }): Task[] {
    let result = Array.from(this.tasks.values());
    if (filter?.status !== undefined) {
      result = result.filter((t) => t.status === filter.status);
    }
    if (filter?.assignee !== undefined) {
      result = result.filter((t) => t.assignee === filter.assignee);
    }
    return result.toSorted((a, b) => a.createdAt - b.createdAt);
  }

  delete(id: string): boolean {
    const removed = this.tasks.delete(id);
    if (removed) {
      this.recomputeBlockedStatuses();
    }
    return removed;
  }

  snapshot(): TaskRegistrySnapshot {
    const all = Array.from(this.tasks.values());
    const byStatus: Record<TaskStatus, number> = {
      pending: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
    };
    for (const t of all) {
      byStatus[t.status]++;
    }
    return { tasks: all, total: all.length, byStatus };
  }

  private isBlocked(dependencies: readonly string[]): boolean {
    for (const depId of dependencies) {
      const dep = this.tasks.get(depId);
      if (dep === undefined || dep.status !== 'completed') {
        return true;
      }
    }
    return false;
  }

  /** Recompute blocked statuses and return IDs of tasks that transitioned blocked→pending. */
  private recomputeBlockedStatuses(): string[] {
    const unblocked: string[] = [];
    for (const [id, task] of this.tasks) {
      const shouldBeBlocked = this.isBlocked(task.dependencies);
      if (shouldBeBlocked && task.status !== 'blocked') {
        this.tasks.set(id, { ...task, status: 'blocked', updatedAt: Date.now() });
      } else if (!shouldBeBlocked && task.status === 'blocked') {
        this.tasks.set(id, { ...task, status: 'pending', updatedAt: Date.now() });
        unblocked.push(id);
      }
    }
    return unblocked;
  }

  /** Flush deferred unblock events on next microtask to avoid creation-time spam. */
  private flushPendingUnblocks(): void {
    if (this.pendingUnblockEmits.length === 0) return;
    const pending = [...this.pendingUnblockEmits];
    this.pendingUnblockEmits = [];
    queueMicrotask(() => {
      for (const item of pending) {
        this.orchestrationHooks?.emit({
          type: 'task.unblocked',
          payload: {
            taskId: item.taskId,
            title: item.title,
            assignee: item.assignee,
          },
        });
      }
    });
  }

  async save(homedir: string): Promise<void> {
    const path = join(homedir, 'state', 'tasks.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ tasks: Array.from(this.tasks.values()), idCounter: this.idCounter }),
      'utf-8',
    );
  }

  async load(homedir: string): Promise<void> {
    try {
      const path = join(homedir, 'state', 'tasks.json');
      const text = await readFile(path, 'utf-8');
      const data = JSON.parse(text) as { tasks?: Task[]; idCounter?: number };
      if (Array.isArray(data.tasks)) {
        for (const task of data.tasks) {
          this.tasks.set(task.id, task);
        }
      }
      if (typeof data.idCounter === 'number') {
        this.idCounter = data.idCounter;
      }
    } catch {
      // ignore
    }
  }
}
