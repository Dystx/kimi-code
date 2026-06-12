/**
 * PlanTrackerTool — structured plan task management.
 *
 * The LLM uses this tool to update task statuses, add or remove tasks, and
 * manage the current task pointer in the durable plan tracker. Unlike the
 * ephemeral TodoList tool store, PlanTracker state is file-backed and
 * survives context compaction.
 */

import { z } from 'zod';

import type { Agent } from '#/agent';
import type { PlanTaskStatus } from '#/agent/plan/tracker';
import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

export const PLAN_TRACKER_TOOL_NAME = 'PlanTracker' as const;

const PlanTaskStatusSchema = z.enum(['pending', 'in_progress', 'done', 'blocked', 'skipped']);

export const PlanTrackerInputSchema = z
  .object({
    action: z
      .enum(['update_status', 'add_task', 'remove_task', 'set_current', 'query'])
      .describe('What to do with the plan tracker.'),
    taskId: z
      .string()
      .optional()
      .describe('Required for update_status, remove_task, and set_current.'),
    status: PlanTaskStatusSchema.optional().describe('Required for update_status.'),
    title: z
      .string()
      .optional()
      .describe('Required for add_task. Short, actionable title.'),
    description: z.string().optional().describe('Optional detail for add_task.'),
    dependencies: z
      .array(z.string())
      .optional()
      .describe('Optional task IDs that must complete before this new task.'),
  })
  .strict();

export type PlanTrackerInput = z.infer<typeof PlanTrackerInputSchema>;

export class PlanTrackerTool implements BuiltinTool<PlanTrackerInput> {
  readonly name = PLAN_TRACKER_TOOL_NAME;
  readonly description = `Manage the durable plan tracker. Use this to mark tasks done, start new tasks, or add/remove tasks from the approved plan. The plan tracker survives context compaction, so keeping it up to date ensures continuity across long sessions.`;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(PlanTrackerInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: PlanTrackerInput): ToolExecution {
    return {
      description: this.describeAction(args),
      approvalRule: this.name,
      execute: async () => {
        const tracker = this.agent.planTracker;
        if (!tracker.isActive) {
          // Auto-initialize from plan mode if a plan has been written but
          // ExitPlanMode has not yet been called.
          if (this.agent.planMode.isActive) {
            try {
              const planData = await this.agent.planMode.data();
              if (planData !== null && planData.content.trim().length > 0) {
                const title = planData.path
                  ? planData.path.split('/').pop()?.replace(/\.md$/, '') ?? 'Plan'
                  : 'Plan';
                await tracker.initializeFromPlan(planData.content, title);
              }
            } catch {
              // Fall through to the error below.
            }
          }
          if (!tracker.isActive) {
            return {
              isError: true,
              output:
                'No active plan tracker. A plan must be approved via ExitPlanMode before tasks can be tracked.',
            };
          }
        }

        switch (args.action) {
          case 'query': {
            return {
              isError: false,
              output: tracker.getSummaryText(),
            };
          }

          case 'update_status': {
            if (!args.taskId || !args.status) {
              return {
                isError: true,
                output: 'update_status requires taskId and status.',
              };
            }
            tracker.updateTaskStatus(args.taskId, args.status as PlanTaskStatus);
            await tracker.save();
            return {
              isError: false,
              output: `Task ${args.taskId} updated to ${args.status}.\n\n${tracker.getSummaryText()}`,
            };
          }

          case 'add_task': {
            if (!args.title) {
              return {
                isError: true,
                output: 'add_task requires title.',
              };
            }
            const id = tracker.addTask({
              title: args.title,
              description: args.description,
              status: 'pending',
              dependencies: args.dependencies,
            });
            await tracker.save();
            return {
              isError: false,
              output: `Added task ${id}: ${args.title}\n\n${tracker.getSummaryText()}`,
            };
          }

          case 'remove_task': {
            if (!args.taskId) {
              return {
                isError: true,
                output: 'remove_task requires taskId.',
              };
            }
            tracker.removeTask(args.taskId);
            await tracker.save();
            return {
              isError: false,
              output: `Removed task ${args.taskId}.\n\n${tracker.getSummaryText()}`,
            };
          }

          case 'set_current': {
            if (!args.taskId) {
              return {
                isError: true,
                output: 'set_current requires taskId.',
              };
            }
            tracker.setCurrentTask(args.taskId);
            await tracker.save();
            return {
              isError: false,
              output: `Current task set to ${args.taskId}.\n\n${tracker.getSummaryText()}`,
            };
          }
        }
      },
    };
  }

  private describeAction(args: PlanTrackerInput): string {
    switch (args.action) {
      case 'query':
        return 'Querying plan tracker';
      case 'update_status':
        return `Updating task ${args.taskId} to ${args.status}`;
      case 'add_task':
        return `Adding task: ${args.title}`;
      case 'remove_task':
        return `Removing task ${args.taskId}`;
      case 'set_current':
        return `Setting current task to ${args.taskId}`;
    }
  }
}
