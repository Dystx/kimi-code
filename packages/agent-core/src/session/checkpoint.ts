import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'pathe';

import type { Session } from '.';

export interface SessionCheckpoint {
  id: string;
  timestamp: number;
  messages: unknown[];
  goals: unknown[];
  tasks: unknown[];
  plan: unknown | null;
  usage: unknown;
  cwd: string;
}

export interface CheckpointListEntry {
  id: string;
  label?: string;
  timestamp: number;
}

export class SessionCheckpointManager {
  constructor(private readonly baseDir: string) {}

  async save(session: Session, label?: string): Promise<string> {
    const id = `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const mainAgent = session.getReadyAgent('main');

    const messages: unknown[] = [];
    if (mainAgent !== undefined) {
      messages.push(...mainAgent.context.history);
    }

    const goals: unknown[] = [];
    const mainAgentGoal = mainAgent?.goal.getGoal().goal ?? null;
    if (mainAgentGoal !== null) {
      goals.push(mainAgentGoal);
    }

    const tasks = [...session.taskRegistry.snapshot().tasks] as unknown[];

    const plan = null;

    const usage = session.costTracker.status();
    const cwd = session.options.kaos.getcwd();

    const checkpoint: SessionCheckpoint = {
      id,
      timestamp: Date.now(),
      messages,
      goals,
      tasks,
      plan,
      usage,
      cwd,
    };

    const checkpointPath = this.checkpointPath(id);
    await mkdir(dirname(checkpointPath), { recursive: true });
    await writeFile(
      checkpointPath,
      JSON.stringify({ ...checkpoint, label: label ?? undefined }, null, 2),
      'utf-8',
    );

    return id;
  }

  async load(checkpointId: string): Promise<SessionCheckpoint> {
    const checkpointPath = this.checkpointPath(checkpointId);
    const text = await readFile(checkpointPath, 'utf-8');
    const data = JSON.parse(text) as SessionCheckpoint & { label?: string };
    return {
      id: data.id,
      timestamp: data.timestamp,
      messages: data.messages,
      goals: data.goals,
      tasks: data.tasks,
      plan: data.plan,
      usage: data.usage,
      cwd: data.cwd,
    };
  }

  async list(): Promise<CheckpointListEntry[]> {
    try {
      const entries = await readdir(this.baseDir);
      const results: CheckpointListEntry[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        try {
          const text = await readFile(join(this.baseDir, entry), 'utf-8');
          const data = JSON.parse(text) as SessionCheckpoint & { label?: string };
          results.push({
            id: data.id,
            label: data.label,
            timestamp: data.timestamp,
          });
        } catch {
          // skip malformed checkpoint files
        }
      }
      return results.sort((a, b) => b.timestamp - a.timestamp);
    } catch {
      return [];
    }
  }

  async delete(checkpointId: string): Promise<void> {
    const checkpointPath = this.checkpointPath(checkpointId);
    await rm(checkpointPath, { force: true });
  }

  private checkpointPath(id: string): string {
    return join(this.baseDir, `${id}.json`);
  }
}
