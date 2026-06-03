import { grandTotal, type TokenUsage } from '@moonshot-ai/kosong';
import type { Kaos } from '@moonshot-ai/kaos';

import type { Agent } from '../agent';
import type { PromptOrigin } from '../agent/context';
import { DenyAllPermissionPolicy } from '../agent/permission/policies/deny-all';
import { InMemoryAgentRecordPersistence } from '../agent/records';
import type { LoopTurnStopReason } from '../loop';
import {
  DEFAULT_AGENT_PROFILES,
  prepareSystemPromptContext,
  type ResolvedAgentProfile,
} from '../profile';
import { linkAbortSignal, userCancellationReason } from '../utils/abort';
import { collectGitContext } from './git-context';
import type { Session } from './index';
import SUMMARY_CONTINUATION_PROMPT from './summary-continuation.md';
import { createWorktree, removeWorktree } from './worktree';

/**
 * A subagent summary shorter than this many characters triggers one
 * follow-up turn that asks the subagent to expand it, so the parent
 * agent receives a technically complete handoff.
 */
const SUMMARY_MIN_LENGTH = 200;
const SUMMARY_CONTINUATION_ATTEMPTS = 1;
const HOOK_TEXT_PREVIEW_LENGTH = 500;
const SUBAGENT_MAX_TOKENS_ERROR =
  'Subagent turn failed before completing its final summary: reason=max_tokens';
const TOOL_CALL_DISABLED_MESSAGE =
  'Tool calls are disabled for side questions. Answer with text only.';
const SIDE_QUESTION_SYSTEM_REMINDER = `
This is a side-channel conversation with the user. You should answer user questions directly based on what you already know.

IMPORTANT:
- You are a separate, lightweight instance.
- The main agent continues independently; do not reference being interrupted.
- Do not call any tools. All tool calls are disabled and will be rejected.
  Even though tool definitions are visible in this request, they exist only
  for technical reasons (prompt cache). You must not use them.
- Respond only with text based on what you already know from the conversation
  and this side-channel conversation.
- Follow-up turns may happen in this side-channel conversation.
- If you do not know the answer, say so directly.
`;

type RunSubagentOptions = {
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string | undefined;
  readonly prompt: string;
  readonly description: string;
  readonly runInBackground: boolean;
  readonly origin?: PromptOrigin | undefined;
  readonly signal: AbortSignal;
  readonly worktree?: boolean | undefined;
  /** Maximum tokens the subagent may consume before being auto-killed. */
  readonly tokenBudget?: number | undefined;
  /** Maximum wall-clock milliseconds the subagent may run before being auto-killed. */
  readonly timeBudgetMs?: number | undefined;
  /** If true, emit progress events on the parent agent after each subagent turn. */
  readonly streamUpdates?: boolean | undefined;
};

type SubagentCompletion = {
  readonly result: string;
  readonly usage?: TokenUsage;
  readonly changes?: string | undefined;
};

type ActiveChild = {
  readonly controller: AbortController;
  readonly runInBackground: boolean;
};

export type SubagentStatus =
  | { kind: 'running'; startedAt: number }
  | { kind: 'completed'; startedAt: number; completedAt: number; result: string; usage?: TokenUsage }
  | { kind: 'failed'; startedAt: number; failedAt: number; error: string };

export type SubagentHandle = {
  readonly agentId: string;
  readonly profileName: string;
  readonly resumed: boolean;
  readonly completion: Promise<SubagentCompletion>;
};

export class SessionSubagentHost {
  private readonly activeChildren = new Map<string, ActiveChild>();
  private readonly subagentStatuses = new Map<string, SubagentStatus>();

  constructor(
    private readonly session: Session,
    private readonly ownerAgentId: string,
    readonly backgroundTaskTimeoutMs?: number | undefined,
  ) {}

  getStatuses(): ReadonlyMap<string, SubagentStatus> {
    return this.subagentStatuses;
  }

  async spawn(profileName: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();

    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);

    const profile = this.resolveProfile(parent, profileName);
    const { id, agent } = await this.session.createAgent(
      { type: 'sub', generate: parent.rawGenerate },
      { parentAgentId: this.ownerAgentId },
    );
    const controller = new AbortController();
    const unlinkAbortSignal = linkAbortSignal(options.signal, controller);
    this.activeChildren.set(id, {
      controller,
      runInBackground: options.runInBackground,
    });

    let worktreePath: string | undefined;
    const completion = this.runChild(
      parent,
      id,
      agent,
      profile.name,
      {
        ...options,
        signal: controller.signal,
      },
      async () => {
        if (options.worktree === true) {
          const wt = await createWorktree(parent.kaos, parent.config.cwd, id);
          worktreePath = wt.path;
        }
        await this.configureChild(parent, agent, profile, worktreePath);
      },
    ).finally(() => {
      unlinkAbortSignal();
      this.activeChildren.delete(id);
      if (worktreePath !== undefined) {
        void removeWorktree(parent.kaos, parent.config.cwd, worktreePath);
      }
    });

    return {
      agentId: id,
      profileName: profile.name,
      resumed: false,
      completion,
    };
  }

  async resume(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();

    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub') {
      throw new Error(`Agent instance "${agentId}" is not a subagent`);
    }
    if (metadata.parentAgentId !== this.ownerAgentId) {
      throw new Error(`Agent instance "${agentId}" does not belong to this parent agent`);
    }
    const child = await this.session.ensureAgentResumed(agentId);
    if (this.activeChildren.has(agentId) || child.turn.hasActiveTurn) {
      throw new Error(
        `Agent instance "${agentId}" is already running and cannot be resumed concurrently`,
      );
    }

    const profileName = child.config.profileName ?? 'subagent';

    const controller = new AbortController();
    const unlinkAbortSignal = linkAbortSignal(options.signal, controller);
    this.activeChildren.set(agentId, {
      controller,
      runInBackground: options.runInBackground,
    });

    const completion = this.runChild(
      parent,
      agentId,
      child,
      profileName,
      {
        ...options,
        signal: controller.signal,
      },
      // A resumed subagent is realigned to the parent agent's current model,
      // so a parent setModel between the initial spawn and the resume is
      // reflected — a subagent always uses the parent agent's model.
      async () => {
        child.config.update({ modelAlias: parent.config.modelAlias });
        // If the child was originally spawned in a worktree that has since been
        // cleaned up, revert its cwd to the parent's cwd so resume doesn't
        // operate in a deleted directory.
        const currentCwd = child.config.cwd;
        const isWorktree = currentCwd.includes('.kimi-worktrees');
        if (isWorktree) {
          try {
            const st = await child.kaos.stat(currentCwd);
            // stMode & S_IFMT === S_IFDIR  (0o040000)
            if ((st.stMode & 0o170000) !== 0o040000) {
              child.config.update({ cwd: parent.config.cwd });
            }
          } catch {
            child.config.update({ cwd: parent.config.cwd });
          }
        }
      },
    ).finally(() => {
      unlinkAbortSignal();
      this.activeChildren.delete(agentId);
    });

    return {
      agentId,
      profileName,
      resumed: true,
      completion,
    };
  }

  async startBtw(): Promise<string> {
    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const { id, agent: child } = await this.session.createAgent(
      {
        type: 'sub',
        generate: parent.rawGenerate,
        persistence: new InMemoryAgentRecordPersistence(),
      },
      { parentAgentId: this.ownerAgentId, persistMetadata: false },
    );

    child.config.update({
      modelAlias: parent.config.modelAlias,
      thinkingLevel: parent.config.thinkingLevel,
      systemPrompt: parent.config.systemPrompt,
    });
    child.tools.copyLoopToolsFrom(parent.tools);
    child.context.useProjectedHistoryFrom(parent.context);
    child.context.appendSystemReminder(SIDE_QUESTION_SYSTEM_REMINDER.trim(), {
      kind: 'system_trigger',
      name: 'btw',
    });
    child.permission.policies.unshift(new DenyAllPermissionPolicy(TOOL_CALL_DISABLED_MESSAGE));
    return id;
  }

  cancelAll(reason: unknown = userCancellationReason()): void {
    const foregroundChildren = Array.from(this.activeChildren).filter(
      ([, child]) => !child.runInBackground,
    );
    for (const [childId, child] of foregroundChildren) {
      this.session.getReadyAgent(childId)?.subagentHost?.cancelAll(reason);
      // Abort with the cancel reason (a user interruption by default) so the
      // subagent's in-flight tools report the cause accurately to the model.
      child.controller.abort(reason);
    }
  }

  async getProfileName(agentId: string): Promise<string | undefined> {
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub' || metadata.parentAgentId !== this.ownerAgentId) {
      return undefined;
    }
    return (await this.session.ensureAgentResumed(agentId)).config.profileName;
  }

  private resolveProfile(parent: Agent, profileName: string): ResolvedAgentProfile {
    const profile =
      DEFAULT_AGENT_PROFILES[parent.config.profileName ?? 'agent']?.subagents?.[profileName] ??
      DEFAULT_AGENT_PROFILES['agent']?.subagents?.[profileName];
    if (profile === undefined) {
      throw new Error(`Subagent profile "${profileName}" was not found`);
    }
    return profile;
  }

  private async runChild(
    parent: Agent,
    childId: string,
    child: Agent,
    profileName: string,
    options: RunSubagentOptions,
    prepareChild: () => Promise<void>,
  ): Promise<SubagentCompletion> {
    parent.emitEvent({
      type: 'subagent.spawned',
      subagentId: childId,
      subagentName: profileName,
      parentToolCallId: options.parentToolCallId,
      parentToolCallUuid: options.parentToolCallUuid,
      parentAgentId: this.ownerAgentId,
      description: options.description,
      runInBackground: options.runInBackground,
    });
    parent.telemetry.track('subagent_created', {
      subagent_name: profileName,
      run_in_background: options.runInBackground,
    });

    const startTime = Date.now();
    this.subagentStatuses.set(childId, { kind: 'running', startedAt: startTime });

    // Capture workspace state before subagent runs so we can diff after.
    const beforeStatus = await captureGitStatus(child.kaos, child.config.cwd);

    try {
      await prepareChild();
      options.signal.throwIfAborted();
      await this.triggerSubagentStart(parent, profileName, options.prompt, options.signal);
      options.signal.throwIfAborted();

      // Explore subagents start cold; a git-context block helps them orient
      // in the repository before searching.
      let childPrompt = options.prompt;
      if (profileName === 'explore') {
        const gitContext = await collectGitContext(child.kaos, child.config.cwd);
        if (gitContext) childPrompt = `${gitContext}\n\n${childPrompt}`;
      }
      const origin: PromptOrigin = options.origin ?? { kind: 'system_trigger', name: 'subagent' };
      child.turn.prompt([{ type: 'text', text: childPrompt }], origin);
      await runChildTurnToCompletion(child, options.signal);

      // Check budgets after each turn
      checkBudgets(child, options, startTime);

      let result = lastAssistantText(child);
      if (options.streamUpdates === true) {
        this.emitSubagentProgress(parent, childId, options.parentToolCallId, result, child);
      }

      // A subagent that returns an overly terse summary leaves the parent
      // agent under-informed. Give it a bounded number of chances to expand
      // the handoff; if it is still short after that, accept it as-is rather
      // than retrying indefinitely.
      let remainingContinuations = SUMMARY_CONTINUATION_ATTEMPTS;
      while (remainingContinuations > 0 && result.length < SUMMARY_MIN_LENGTH) {
        remainingContinuations -= 1;
        options.signal.throwIfAborted();
        checkBudgets(child, options, startTime);
        child.turn.prompt([{ type: 'text', text: SUMMARY_CONTINUATION_PROMPT }], origin);
        await runChildTurnToCompletion(child, options.signal);
        checkBudgets(child, options, startTime);
        result = lastAssistantText(child);
        if (options.streamUpdates === true) {
          this.emitSubagentProgress(parent, childId, options.parentToolCallId, result, child);
        }
      }
      const usage = child.usage.data().total;
      const changes = await computeGitDiff(child.kaos, child.config.cwd, beforeStatus);
      this.subagentStatuses.set(childId, {
        kind: 'completed',
        startedAt: startTime,
        completedAt: Date.now(),
        result,
        usage,
      });
      parent.emitEvent({
        type: 'subagent.completed',
        subagentId: childId,
        parentToolCallId: options.parentToolCallId,
        resultSummary: result,
        usage,
        contextTokens: child.context.tokenCount,
      });
      this.triggerSubagentStop(parent, profileName, result);
      return { result, usage, changes };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.subagentStatuses.set(childId, {
        kind: 'failed',
        startedAt: startTime,
        failedAt: Date.now(),
        error: message,
      });
      parent.emitEvent({
        type: 'subagent.failed',
        subagentId: childId,
        parentToolCallId: options.parentToolCallId,
        error: message,
      });
      throw error;
    }
  }

  private async configureChild(
    parent: Agent,
    child: Agent,
    profile: ResolvedAgentProfile,
    worktreePath?: string,
  ): Promise<void> {
    // A subagent always inherits the parent agent's model.
    child.config.update({
      cwd: worktreePath ?? parent.config.cwd,
      modelAlias: parent.config.modelAlias,
      thinkingLevel: parent.config.thinkingLevel,
    });

    const context = await prepareSystemPromptContext(child.kaos);
    child.useProfile(profile, context);
    child.tools.inheritUserTools(parent.tools);
  }

  private async triggerSubagentStart(
    parent: Agent,
    profileName: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<void> {
    await parent.hooks?.trigger('SubagentStart', {
      matcherValue: profileName,
      signal,
      inputData: {
        agentName: profileName,
        prompt: prompt.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
      },
    });
  }

  private triggerSubagentStop(parent: Agent, profileName: string, result: string): void {
    void parent.hooks?.fireAndForgetTrigger('SubagentStop', {
      matcherValue: profileName,
      inputData: {
        agentName: profileName,
        response: result.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
      },
    });
  }

  private emitSubagentProgress(
    parent: Agent,
    subagentId: string,
    parentToolCallId: string,
    preview: string,
    child: Agent,
  ): void {
    parent.emitEvent({
      type: 'subagent.progress',
      subagentId,
      parentToolCallId,
      preview: preview.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
      usage: child.usage.data().total,
      contextTokens: child.context.tokenCount,
    });
  }
}

async function runChildTurnToCompletion(child: Agent, signal: AbortSignal): Promise<void> {
  const completion = await child.turn.waitForCurrentTurn(signal);
  const turnEnded = completion.event;
  if (turnEnded.reason !== 'completed') {
    throw new Error(
      turnEnded.error === undefined
        ? `Subagent turn ${turnEnded.reason}`
        : `[${turnEnded.error.code}] ${turnEnded.error.message}`,
    );
  }
  throwIfSubagentStoppedAtMaxTokens(completion.stopReason);
}

async function captureGitStatus(kaos: Kaos, cwd: string): Promise<string | undefined> {
  try {
    const proc = await kaos.withCwd(cwd).execWithEnv(
      ['git', 'status', '--short'],
      { ...process.env as Record<string, string>, GIT_TERMINAL_PROMPT: '0' },
    );
    proc.stdin.end();
    const chunks: Buffer[] = [];
    for await (const chunk of proc.stdout) {
      chunks.push(chunk);
    }
    const output = Buffer.concat(chunks).toString('utf-8').trim();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

async function computeGitDiff(
  kaos: Kaos,
  cwd: string,
  beforeStatus: string | undefined,
): Promise<string | undefined> {
  try {
    const afterStatus = await captureGitStatus(kaos, cwd);
    if (!beforeStatus && !afterStatus) return undefined;

    // If we have before/after status, compute the delta
    const beforeLines = new Set(beforeStatus?.split('\n') ?? []);
    const afterLines = new Set(afterStatus?.split('\n') ?? []);
    const added: string[] = [];
    for (const line of afterLines) {
      if (!beforeLines.has(line)) added.push(line);
    }
    if (added.length === 0) return undefined;

    // Also try to get actual diff content for the changed files
    const diffProc = await kaos.withCwd(cwd).execWithEnv(
      ['git', 'diff', '--stat'],
      { ...process.env as Record<string, string>, GIT_TERMINAL_PROMPT: '0' },
    );
    diffProc.stdin.end();
    const diffChunks: Buffer[] = [];
    for await (const chunk of diffProc.stdout) {
      diffChunks.push(chunk);
    }
    const diffStat = Buffer.concat(diffChunks).toString('utf-8').trim();

    const lines: string[] = ['Files changed:'];
    for (const change of added) {
      lines.push(`  ${change}`);
    }
    if (diffStat.length > 0) {
      lines.push('');
      lines.push(diffStat);
    }
    return lines.join('\n');
  } catch {
    return undefined;
  }
}

function checkBudgets(
  child: Agent,
  options: RunSubagentOptions,
  startTime: number,
): void {
  if (options.tokenBudget !== undefined) {
    const total = child.usage.data().total;
    if (total !== undefined) {
      const used = grandTotal(total);
      if (used >= options.tokenBudget) {
        throw new Error(`Subagent exceeded token budget (${used}/${options.tokenBudget})`);
      }
    }
  }
  if (options.timeBudgetMs !== undefined) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= options.timeBudgetMs) {
      throw new Error(
        `Subagent exceeded time budget (${Math.round(elapsed / 1000)}s/${Math.round(options.timeBudgetMs / 1000)}s)`,
      );
    }
  }
}

function throwIfSubagentStoppedAtMaxTokens(stopReason: LoopTurnStopReason | undefined): void {
  if (stopReason === 'max_tokens') {
    throw new Error(`${SUBAGENT_MAX_TOKENS_ERROR}.`);
  }
}

function lastAssistantText(agent: Agent): string {
  for (const message of [...agent.context.history].toReversed()) {
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
    if (text.trim().length > 0) return text.trim();
  }
  return '';
}
