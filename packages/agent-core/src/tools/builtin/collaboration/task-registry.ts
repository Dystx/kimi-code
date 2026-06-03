/**
 * Task registry tools — multi-agent task coordination with dependencies.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { SessionTaskRegistry, TaskStatus } from '../../../session/task-registry';

const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed', 'failed', 'blocked'];

// ── CreateTask ───────────────────────────────────────────────────────

export const CreateTaskInputSchema = z.object({
  title: z.string().describe('Short task title (3-10 words)'),
  description: z.string().optional().describe('Detailed task description'),
  assignee: z.string().optional().describe('Agent ID to assign this task to. Omit for unassigned.'),
  dependencies: z
    .array(z.string())
    .optional()
    .describe('Task IDs that must complete before this task can start.'),
});

export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export class CreateTaskTool implements BuiltinTool<CreateTaskInput> {
  readonly name = 'CreateTask';
  readonly description =
    'Create a new task in the shared session registry. Tasks can have dependencies on other tasks — a task with incomplete dependencies is marked "blocked" until they finish. Use this to coordinate work across multiple subagents.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(CreateTaskInputSchema);

  constructor(private readonly registry: SessionTaskRegistry) {}

  resolveExecution(args: CreateTaskInput): ToolExecution {
    return {
      description: `Creating task: ${args.title}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private execution(args: CreateTaskInput): Promise<ExecutableToolResult> {
    const task = this.registry.create(args.title, {
      description: args.description,
      assignee: args.assignee,
      dependencies: args.dependencies,
    });
    const lines = [
      `task_id: ${task.id}`,
      `status: ${task.status}`,
      `title: ${task.title}`,
      ...(task.assignee ? [`assignee: ${task.assignee}`] : []),
      ...(task.dependencies.length > 0 ? [`dependencies: ${task.dependencies.join(', ')}`] : []),
    ];
    return Promise.resolve({ output: lines.join('\n') });
  }
}

// ── UpdateTask ───────────────────────────────────────────────────────

export const UpdateTaskInputSchema = z.object({
  task_id: z.string().describe('ID of the task to update'),
  status: z.enum(TASK_STATUSES).optional().describe('New status'),
  assignee: z.string().optional().describe('Agent ID to assign or reassign'),
  result: z.string().optional().describe('Result summary or output to record'),
});

export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>;

export class UpdateTaskTool implements BuiltinTool<UpdateTaskInput> {
  readonly name = 'UpdateTask';
  readonly description =
    'Update a task\'s status, assignee, or result. Use this to claim a task (status=in_progress), mark it done (status=completed), or report failure (status=failed). When a task completes, dependent tasks are automatically unblocked.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(UpdateTaskInputSchema);

  constructor(private readonly registry: SessionTaskRegistry) {}

  resolveExecution(args: UpdateTaskInput): ToolExecution {
    return {
      description: `Updating task ${args.task_id}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private execution(args: UpdateTaskInput): Promise<ExecutableToolResult> {
    const updated = this.registry.update(args.task_id, {
      status: args.status,
      assignee: args.assignee,
      result: args.result,
    });
    if (updated === undefined) {
      return Promise.resolve({ output: `Task ${args.task_id} not found.`, isError: true });
    }
    const lines = [
      `task_id: ${updated.id}`,
      `status: ${updated.status}`,
      ...(updated.assignee ? [`assignee: ${updated.assignee}`] : []),
      ...(updated.result ? [`result: ${updated.result}`] : []),
    ];
    return Promise.resolve({ output: lines.join('\n') });
  }
}

// ── ListTasks ────────────────────────────────────────────────────────

export const ListTasksInputSchema = z.object({
  filter_status: z.enum(TASK_STATUSES).optional().describe('Filter by status'),
  filter_assignee: z.string().optional().describe('Filter by assignee agent ID'),
});

export type ListTasksInput = z.infer<typeof ListTasksInputSchema>;

export class ListTasksTool implements BuiltinTool<ListTasksInput> {
  readonly name = 'ListTasks';
  readonly description =
    'List all tasks in the session registry, optionally filtered by status or assignee. Use this to check what work is pending, blocked, or ready to start.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ListTasksInputSchema);

  constructor(private readonly registry: SessionTaskRegistry) {}

  resolveExecution(args: ListTasksInput): ToolExecution {
    return {
      description: 'Listing tasks',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private execution(args: ListTasksInput): Promise<ExecutableToolResult> {
    const snapshot = this.registry.snapshot();
    const tasks = this.registry.list({
      status: args.filter_status,
      assignee: args.filter_assignee,
    });

    if (snapshot.total === 0) {
      return Promise.resolve({ output: 'No tasks in registry.' });
    }

    const lines = [
      `Tasks (${snapshot.total} total)`,
      `  pending: ${snapshot.byStatus.pending}, in_progress: ${snapshot.byStatus.in_progress}, completed: ${snapshot.byStatus.completed}, failed: ${snapshot.byStatus.failed}, blocked: ${snapshot.byStatus.blocked}`,
      '',
    ];

    for (const task of tasks) {
      lines.push(`${task.id} [${task.status}] ${task.title}`);
      if (task.assignee) lines.push(`  assignee: ${task.assignee}`);
      if (task.dependencies.length > 0) lines.push(`  deps: ${task.dependencies.join(', ')}`);
    }

    return Promise.resolve({ output: lines.join('\n') });
  }
}

// ── GetTask ──────────────────────────────────────────────────────────

export const GetTaskInputSchema = z.object({
  task_id: z.string().describe('Task ID to retrieve'),
});

export type GetTaskInput = z.infer<typeof GetTaskInputSchema>;

export class GetTaskTool implements BuiltinTool<GetTaskInput> {
  readonly name = 'GetTask';
  readonly description = 'Get full details of a specific task by ID.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GetTaskInputSchema);

  constructor(private readonly registry: SessionTaskRegistry) {}

  resolveExecution(args: GetTaskInput): ToolExecution {
    return {
      description: `Getting task ${args.task_id}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private execution(args: GetTaskInput): Promise<ExecutableToolResult> {
    const task = this.registry.get(args.task_id);
    if (task === undefined) {
      return Promise.resolve({ output: `Task ${args.task_id} not found.`, isError: true });
    }
    const lines = [
      `task_id: ${task.id}`,
      `status: ${task.status}`,
      `title: ${task.title}`,
      ...(task.description ? [`description: ${task.description}`] : []),
      ...(task.assignee ? [`assignee: ${task.assignee}`] : []),
      ...(task.dependencies.length > 0 ? [`dependencies: ${task.dependencies.join(', ')}`] : []),
      ...(task.result ? [`result: ${task.result}`] : []),
      `created: ${new Date(task.createdAt).toISOString()}`,
      `updated: ${new Date(task.updatedAt).toISOString()}`,
    ];
    return Promise.resolve({ output: lines.join('\n') });
  }
}
