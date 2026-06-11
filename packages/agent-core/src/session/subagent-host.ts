import {
  APIProviderRateLimitError,
  grandTotal,
  isProviderRateLimitError,
  type TokenUsage,
} from '@moonshot-ai/kosong';
import type { Kaos } from '@moonshot-ai/kaos';
import type { Agent } from '../agent';
import type { PromptOrigin } from '../agent/context';
import { ErrorCodes, type KimiErrorPayload } from '../errors';
import { DenyAllPermissionPolicy } from '../agent/permission/policies/deny-all';
import { InMemoryAgentRecordPersistence } from '../agent/records';
import { isAbortError } from '../loop/errors';
import {
  DEFAULT_AGENT_PROFILES,
  prepareSystemPromptContext,
  type ResolvedAgentProfile,
} from '../profile';
import {
  linkAbortSignal,
  userCancellationReason,
} from '../utils/abort';
import { collectGitContext } from './git-context';
import type { Session } from './index';
import {
  SubagentBatch,
  type SubagentResult,
  type SubagentSuspendedEvent,
  type QueuedSubagentTask,
} from './subagent-batch';
import SUMMARY_CONTINUATION_PROMPT from './summary-continuation.md';
import { createWorktree, removeWorktree } from './worktree';
import type { LoopTurnStopReason } from '../loop/types';

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_SUBAGENT_TIMEOUT_DESCRIPTION = '30 minutes';

export type {
  SubagentResult as QueuedSubagentRunResult,
  QueuedSubagentTask,
  ResumeQueuedSubagentTask,
  SpawnQueuedSubagentTask,
} from './subagent-batch';

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
const SUBAGENT_PROMPT_ORIGIN: PromptOrigin = { kind: 'system_trigger', name: 'subagent' };
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
- If you do not know the answer, say so directly.
`;

export interface RunSubagentOptions {
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly prompt: string;
  readonly description: string;
  readonly swarmIndex?: number;
  readonly runInBackground: boolean;
  readonly signal: AbortSignal;
  readonly worktree?: boolean | undefined;
  /** Maximum tokens the subagent may consume before being auto-killed. */
  readonly tokenBudget?: number | undefined;
  /** Maximum wall-clock milliseconds the subagent may run before being auto-killed. */
  readonly timeBudgetMs?: number | undefined;
  /** If true, emit progress events on the parent agent after each subagent turn. */
  readonly streamUpdates?: boolean | undefined;
  readonly onReady?: () => void;
  readonly suppressRateLimitFailureEvent?: boolean;
}

export interface SpawnSubagentOptions extends RunSubagentOptions {
  readonly profileName: string;
  readonly swarmItem?: string;
}

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
  ) {}

  getStatuses(): ReadonlyMap<string, SubagentStatus> {
    return this.subagentStatuses;
  }

  /** Number of subagents that are still running (not completed or failed). */
  getActiveCount(): number {
    let count = 0;
    for (const status of this.subagentStatuses.values()) {
      if (status.kind === 'running') {
        count++;
      }
    }
    return count;
  }

  async spawn(options: SpawnSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();

    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const profile = this.resolveProfile(parent, options.profileName);
    const { id, agent } = await this.session.createAgent(
      { type: 'sub', generate: parent.rawGenerate },
      { parentAgentId: this.ownerAgentId, swarmItem: options.swarmItem },
    );

    let worktreePath: string | undefined;
    const completion = this.runWithActiveChild(id, options, async (runOptions) => {
      if (options.worktree === true) {
        const wt = await createWorktree(parent.kaos, parent.config.cwd, id);
        worktreePath = wt.path;
      }
      this.emitSubagentSpawned(parent, id, profile.name, runOptions);
      try {
        await this.configureChild(parent, agent, profile, worktreePath);
        this.session.orchestrationHooks?.emit({
          type: 'subagent.started',
          payload: {
            subagentId: id,
            profileName: profile.name,
            worktree: worktreePath !== undefined,
          },
        });
        return await this.runPromptTurn(parent, id, agent, profile.name, runOptions);
      } catch (error) {
        this.emitSubagentFailed(parent, id, profile.name, runOptions, error);
        throw error;
      }
    }).finally(() => {
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
    const { parent, child, profileName } = await this.ensureIdleSubagent(agentId);
    const completion = this.runWithActiveChild(agentId, options, async (runOptions) => {
      this.emitSubagentSpawned(parent, agentId, profileName, runOptions);
      try {
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
        return await this.runPromptTurn(parent, agentId, child, profileName, runOptions);
      } catch (error) {
        this.emitSubagentFailed(parent, agentId, profileName, runOptions, error);
        throw error;
      }
    });
    return { agentId, profileName, resumed: true, completion };
  }

  async retry(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    const { parent, child, profileName } = await this.ensureIdleSubagent(agentId);
    const completion = this.runWithActiveChild(agentId, options, async (runOptions) => {
      try {
        runOptions.signal.throwIfAborted();
        child.config.update({ modelAlias: parent.config.modelAlias });
        this.emitSubagentStarted(parent, agentId);
        const turnId = child.turn.retry('agent-host');
        if (turnId === null) {
          throw new Error(`Agent instance "${agentId}" could not start a retry turn`);
        }
        this.observeFirstRequest(child, runOptions);
        return await this.waitForChildCompletion(parent, agentId, child, profileName, runOptions);
      } catch (error) {
        this.emitSubagentFailed(parent, agentId, profileName, runOptions, error);
        throw error;
      }
    });
    return { agentId, profileName, resumed: true, completion };
  }

  private async ensureIdleSubagent(
    agentId: string,
  ): Promise<{ readonly parent: Agent; readonly child: Agent; readonly profileName: string }> {
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
      throw new Error(`Agent instance "${agentId}" is already running and cannot run concurrently`);
    }

    const profileName = child.config.profileName ?? 'subagent';
    return { parent, child, profileName };
  }

  async runQueued<T>(tasks: readonly QueuedSubagentTask<T>[]): Promise<Array<SubagentResult<T>>> {
    return new SubagentBatch(this, tasks).run();
  }

  suspended(event: SubagentSuspendedEvent): void {
    const parent = this.session.getReadyAgent?.(this.ownerAgentId);
    parent?.emitEvent({
      type: 'subagent.suspended',
      subagentId: event.agentId,
      reason: event.reason,
    });
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

  getSwarmItem(agentId: string): string | undefined {
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub' || metadata.parentAgentId !== this.ownerAgentId) {
      return undefined;
    }
    return metadata.swarmItem;
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

  private runWithActiveChild(
    childId: string,
    options: RunSubagentOptions,
    run: (options: RunSubagentOptions) => Promise<SubagentCompletion>,
  ): Promise<SubagentCompletion> {
    const controller = new AbortController();
    const unlinkAbortSignal = linkAbortSignal(options.signal, controller);
    this.activeChildren.set(childId, {
      controller,
      runInBackground: options.runInBackground,
    });

    return run({ ...options, signal: controller.signal }).finally(() => {
      unlinkAbortSignal();
      this.activeChildren.delete(childId);
    });
  }

  private async runPromptTurn(
    parent: Agent,
    childId: string,
    child: Agent,
    profileName: string,
    options: RunSubagentOptions,
  ): Promise<SubagentCompletion> {
    options.signal.throwIfAborted();
    await this.triggerSubagentStart(parent, profileName, options.prompt, options.signal);
    options.signal.throwIfAborted();

    const startTime = Date.now();
    this.subagentStatuses.set(childId, { kind: 'running', startedAt: startTime });

    const beforeStatus = await captureGitStatus(child.kaos, child.config.cwd);

    let childPrompt = options.prompt;
    if (profileName === 'explore') {
      const gitContext = await collectGitContext(child.kaos, child.config.cwd);
      if (gitContext) childPrompt = `${gitContext}\n\n${childPrompt}`;
    }

    this.emitSubagentStarted(parent, childId);
    const turnId = child.turn.prompt([{ type: 'text', text: childPrompt }], SUBAGENT_PROMPT_ORIGIN);
    if (turnId === null) {
      throw new Error(`Agent instance "${childId}" could not start a turn`);
    }
    this.observeFirstRequest(child, options);

    try {
      return await this.waitForChildCompletion(parent, childId, child, profileName, options, startTime, beforeStatus);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.subagentStatuses.set(childId, {
        kind: 'failed',
        startedAt: startTime,
        failedAt: Date.now(),
        error: message,
      });
      parent.onSubagentCompleted?.(profileName, true, {
        durationMs: Date.now() - startTime,
      });
      throw error;
    }
  }

  private async waitForChildCompletion(
    parent: Agent,
    childId: string,
    child: Agent,
    profileName: string,
    options: RunSubagentOptions,
    startTime?: number,
    beforeStatus?: string,
  ): Promise<SubagentCompletion> {
    await runChildTurnToCompletion(child, options.signal);

    let result = lastAssistantText(child);
    let remainingContinuations = SUMMARY_CONTINUATION_ATTEMPTS;
    while (remainingContinuations > 0 && result.length < SUMMARY_MIN_LENGTH) {
      remainingContinuations -= 1;
      options.signal.throwIfAborted();
      if (startTime !== undefined) {
        checkBudgets(child, options, startTime);
      }
      child.turn.prompt([{ type: 'text', text: SUMMARY_CONTINUATION_PROMPT }], SUBAGENT_PROMPT_ORIGIN);
      await runChildTurnToCompletion(child, options.signal);
      result = lastAssistantText(child);
      if (options.streamUpdates === true) {
        this.emitSubagentProgress(parent, childId, options.parentToolCallId, result, child);
      }
    }

    if (startTime !== undefined) {
      checkBudgets(child, options, startTime);
    }

    const usage = child.usage.data().total;
    const changes = beforeStatus !== undefined
      ? await computeGitDiff(child.kaos, child.config.cwd, beforeStatus)
      : undefined;
    const hasMeaningfulDiff = changes !== undefined && changes.split('\n').some((line) => line.startsWith('+') || line.startsWith('-'));

    if (startTime !== undefined) {
      this.subagentStatuses.set(childId, {
        kind: 'completed',
        startedAt: startTime,
        completedAt: Date.now(),
        result,
        usage,
      });
    }

    parent.emitEvent({
      type: 'subagent.completed',
      subagentId: childId,
      resultSummary: result,
      usage,
      contextTokens: child.context.tokenCount,
    });
    this.session.orchestrationHooks?.emit({
      type: 'subagent.completed',
      payload: {
        subagentId: childId,
        profileName,
        hasDiff: hasMeaningfulDiff,
        resultSummary: result,
        durationMs: startTime !== undefined ? Date.now() - startTime : undefined,
        tokenUsage: usage
          ? {
              input: usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation,
              output: usage.output,
            }
          : undefined,
        contextTokens: child.context.tokenCount,
      },
    });
    this.triggerSubagentStop(parent, profileName, result);
    if (startTime !== undefined) {
      parent.onSubagentCompleted?.(profileName, false, {
        tokenUsage: usage ? { input: usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation, output: usage.output } : undefined,
        durationMs: Date.now() - startTime,
      });
    }

    return { result, usage, changes };
  }

  private async configureChild(
    parent: Agent,
    child: Agent,
    profile: ResolvedAgentProfile,
    worktreePath?: string,
  ): Promise<void> {
    // A subagent inherits the parent agent's model by default, but the profile
    // can override modelAlias and thinkingLevel to enable architect/editor split.
    child.config.update({
      cwd: worktreePath ?? parent.config.cwd,
      modelAlias: profile.modelAlias ?? parent.config.modelAlias,
      thinkingLevel: profile.thinkingLevel ?? parent.config.thinkingLevel,
    });

    const context = await prepareSystemPromptContext(
      this.session.systemContextKaos(child.kaos.getcwd()),
      this.session.options.kimiHomeDir,
    );
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

  private observeFirstRequest(
    child: Agent,
    options: RunSubagentOptions,
  ): void {
    if (options.onReady === undefined) return;
    void child.turn
      .waitForTurnFirstRequest()
      .then(() => {
        options.onReady?.();
      })
      .catch(() => {});
  }

  private emitSubagentSpawned(
    parent: Agent,
    childId: string,
    profileName: string,
    options: RunSubagentOptions,
  ): void {
    parent.emitEvent({
      type: 'subagent.spawned',
      subagentId: childId,
      subagentName: profileName,
      parentToolCallId: options.parentToolCallId,
      parentToolCallUuid: options.parentToolCallUuid,
      parentAgentId: this.ownerAgentId,
      description: options.description,
      swarmIndex: options.swarmIndex,
      runInBackground: options.runInBackground,
    });
    parent.telemetry.track('subagent_created', {
      subagent_name: profileName,
      run_in_background: options.runInBackground,
    });
  }

  private emitSubagentStarted(
    parent: Agent,
    childId: string,
  ): void {
    parent.emitEvent({
      type: 'subagent.started',
      subagentId: childId,
    });
  }

  private emitSubagentFailed(
    parent: Agent,
    childId: string,
    profileName: string,
    options: RunSubagentOptions,
    error: unknown,
  ): void {
    if (shouldSuppressQueuedAttemptFailureEvent(options, error)) return;
    const errorMessage = error instanceof Error ? error.message : String(error);
    parent.emitEvent({
      type: 'subagent.failed',
      subagentId: childId,
      error: errorMessage,
    });
    this.session.orchestrationHooks?.emit({
      type: 'subagent.failed',
      payload: {
        subagentId: childId,
        profileName,
        error: errorMessage,
      },
    });
  }
}

async function runChildTurnToCompletion(child: Agent, signal: AbortSignal): Promise<void> {
  const completion = await child.turn.waitForCurrentTurn(signal);
  const turnEnded = completion.event;
  if (turnEnded.reason !== 'completed') {
    if (turnEnded.error?.code === ErrorCodes.PROVIDER_RATE_LIMIT) {
      throw providerRateLimitErrorFromPayload(turnEnded.error);
    }
    throw new Error(
      turnEnded.error === undefined
        ? `Subagent turn ${turnEnded.reason}`
        : `[${turnEnded.error.code}] ${turnEnded.error.message}`,
    );
  }
  if (completion.stopReason === 'max_tokens') {
    throw new Error(`${SUBAGENT_MAX_TOKENS_ERROR}.`);
  }
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

function providerRateLimitErrorFromPayload(error: KimiErrorPayload): APIProviderRateLimitError {
  const requestId =
    typeof error.details?.['requestId'] === 'string' ? error.details['requestId'] : null;
  return new APIProviderRateLimitError(error.message, requestId);
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

function shouldSuppressQueuedAttemptFailureEvent(
  options: RunSubagentOptions,
  error: unknown,
): boolean {
  if (options.suppressRateLimitFailureEvent !== true) return false;
  if (isProviderRateLimitError(error)) return true;
  return isAbortError(error) || options.signal.aborted;
}
