import {
  createKimiHarness,
  log,
  type Event,
  type GoalSnapshot,
  type HookResultEvent,
  type KimiHarness,
  type Session,
  type SessionStatus,
  type TelemetryClient,
} from '@moonshot-ai/kimi-code-sdk';
import {
  setCrashPhase,
  setTelemetryContext,
  shutdownTelemetry,
  track,
  withTelemetryContext,
} from '@moonshot-ai/kimi-telemetry';

import { CLI_SHUTDOWN_TIMEOUT_MS } from '#/constant/app';
import { experimentalFeatureMap } from '#/utils/experimental-features';

import { createCliTelemetryBootstrap, initializeCliTelemetry } from '../cli/telemetry';
import { createKimiCodeHostIdentity } from '../cli/version';
import {
  formatGoalSummaryText,
  goalExitCode,
  goalSummaryJson,
  parseHeadlessGoalCreate,
  type HeadlessGoalCreate,
} from '../cli/goal-prompt';

export interface HeadlessOptions {
  prompt: string;
  cwd: string;
  maxTurns?: number;
  exitOnCompletion?: boolean;
  outputFormat?: 'text' | 'json';
}

export interface HeadlessResult {
  success: boolean;
  output: string;
  cost: number;
  tokens: number;
  turnCount: number;
  maxTurnsExceeded?: boolean;
}

const HEADLESS_UI_MODE = 'print';
const HEADLESS_MAIN_AGENT_ID = 'main';

export async function runHeadless(options: HeadlessOptions): Promise<HeadlessResult> {
  const startedAt = Date.now();
  const workDir = options.cwd;
  const telemetryBootstrap = createCliTelemetryBootstrap();
  const telemetryClient: TelemetryClient = {
    track,
    withContext: withTelemetryContext,
    setContext: setTelemetryContext,
  };
  const harness = createKimiHarness({
    homeDir: telemetryBootstrap.homeDir,
    identity: createKimiCodeHostIdentity('0.0.0'),
    uiMode: HEADLESS_UI_MODE,
    telemetry: telemetryClient,
    onOAuthRefresh: (outcome) => {
      if (outcome.success) {
        track('oauth_refresh', { success: true });
        return;
      }
      track('oauth_refresh', { success: false, reason: outcome.reason });
    },
  });
  log.info('kimi-code headless starting', {
    uiMode: HEADLESS_UI_MODE,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    workDir,
    maxTurns: options.maxTurns ?? 'default',
    outputFormat: options.outputFormat ?? 'text',
  });

  let restorePromptSessionPermission = async (): Promise<void> => {};
  let removeTerminationCleanup: (() => void) | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanupHeadlessRun = async (): Promise<void> => {
    cleanupPromise ??= (async () => {
      removeTerminationCleanup?.();
      setCrashPhase('shutdown');
      try {
        await restorePromptSessionPermission();
      } finally {
        await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS });
        await harness.close();
      }
    })();
    await cleanupPromise;
  };
  removeTerminationCleanup = installHeadlessTerminationCleanup(process, cleanupHeadlessRun);

  let result: HeadlessResult;
  try {
    await harness.ensureConfigFile();
    const config = await harness.getConfig();
    const { session, resumed, restorePermission, telemetryModel, goalModel } =
      await resolveHeadlessSession(harness, workDir, config.defaultModel, (restorePermission) => {
        restorePromptSessionPermission = restorePermission;
      });
    restorePromptSessionPermission = restorePermission;

    initializeCliTelemetry({
      harness,
      bootstrap: telemetryBootstrap,
      config,
      version: '0.0.0',
      uiMode: HEADLESS_UI_MODE,
      model: telemetryModel,
    });
    setCrashPhase('runtime');

    withTelemetryContext({ sessionId: session.id }).track('started', {
      resumed,
      yolo: false,
      plan: false,
      afk: true,
    });

    const flagMap = experimentalFeatureMap(await harness.getExperimentalFeatures());
    const goalCreate = parseHeadlessGoalCreate(options.prompt, flagMap['goal_command'] === true);
    if (goalCreate !== undefined) {
      result = await runHeadlessGoalSession(
        session,
        goalCreate,
        goalModel,
        options.maxTurns ?? 50,
      );
    } else {
      result = await runHeadlessTurn(session, options.prompt, options.maxTurns ?? 1);
    }

    withTelemetryContext({ sessionId: session.id }).track('exit', {
      duration_s: (Date.now() - startedAt) / 1000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = {
      success: false,
      output: message,
      cost: 0,
      tokens: 0,
      turnCount: 0,
    };
  } finally {
    await cleanupHeadlessRun();
  }

  return result;
}

async function runHeadlessGoalSession(
  session: Session,
  goal: HeadlessGoalCreate,
  model: string | undefined,
  maxTurns: number,
): Promise<HeadlessResult> {
  requireConfiguredModel(model);
  await session.createGoal({
    objective: goal.objective,
    replace: goal.replace,
  });
  let completedSnapshot: GoalSnapshot | null = null;
  const unsubscribeGoalEvents = session.onEvent((event) => {
    if (
      event.type === 'goal.updated' &&
      event.change?.kind === 'completion' &&
      event.snapshot !== null
    ) {
      completedSnapshot = event.snapshot;
    }
  });

  let output = '';
  let turnCount = 0;
  let maxTurnsExceeded = false;
  let promptError: Error | undefined;

  try {
    const promptPromise = session.prompt(goal.objective).catch((error: unknown) => {
      promptError = error instanceof Error ? error : new Error(String(error));
    });

    const turnPromise = new Promise<void>((resolve, reject) => {
      const unsubscribe = session.onEvent((event) => {
        if (event.type === 'error' && event.agentId === HEADLESS_MAIN_AGENT_ID) {
          unsubscribe();
          reject(new Error(`${event.code}: ${event.message}`));
          return;
        }
        if (event.type === 'assistant.delta' && event.agentId === HEADLESS_MAIN_AGENT_ID) {
          output += event.delta;
          return;
        }
        if (event.type === 'turn.ended' && event.agentId === HEADLESS_MAIN_AGENT_ID) {
          turnCount += 1;
          if (turnCount >= maxTurns) {
            unsubscribe();
            void session.cancel();
            resolve();
            return;
          }
          if (completedSnapshot !== null) {
            unsubscribe();
            resolve();
          }
          return;
        }
      });
    });

    await Promise.race([promptPromise, turnPromise]);

    if (promptError !== undefined) {
      throw promptError;
    }

    if (turnCount >= maxTurns && completedSnapshot === null) {
      maxTurnsExceeded = true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output = output || message;
  } finally {
    unsubscribeGoalEvents();
    const snapshot = completedSnapshot ?? (await session.getGoal()).goal;
    if (snapshot !== null && snapshot.status !== 'complete') {
      output += `\n${formatGoalSummaryText(snapshot)}`;
    }
  }

  const { cost, tokens } = await extractUsage(session);
  const finalSnapshot = completedSnapshot as GoalSnapshot | null;
  return {
    success: finalSnapshot?.status === 'complete',
    output,
    cost,
    tokens,
    turnCount,
    maxTurnsExceeded,
  };
}

async function runHeadlessTurn(
  session: Session,
  prompt: string,
  maxTurns: number,
): Promise<HeadlessResult> {
  let activeTurnId: number | undefined;
  let activeAgentId: string | undefined;
  let assistantText = '';
  let turnCount = 0;
  let settled = false;
  let unsubscribe: (() => void) | undefined;

  const runSingleTurn = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        unsubscribe?.();
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      };

      unsubscribe = session.onEvent((event) => {
        if (event.type === 'error') {
          if (event.agentId !== HEADLESS_MAIN_AGENT_ID) {
            return;
          }
          finish(new Error(`${event.code}: ${event.message}`));
          return;
        }
        if (event.type === 'turn.started' && activeTurnId === undefined) {
          if (event.agentId !== HEADLESS_MAIN_AGENT_ID) {
            return;
          }
          activeTurnId = event.turnId;
          activeAgentId = event.agentId;
          return;
        }
        if (
          activeTurnId === undefined ||
          activeAgentId === undefined ||
          !hasTurnId(event) ||
          event.turnId !== activeTurnId ||
          event.agentId !== activeAgentId
        ) {
          return;
        }
        switch (event.type) {
          case 'assistant.delta':
            assistantText += event.delta;
            return;
          case 'turn.ended':
            if (event.reason === 'completed') {
              finish();
              return;
            }
            finish(new Error(formatTurnEndedFailure(event)));
            return;
          case 'turn.step.started':
          case 'turn.step.interrupted':
          case 'turn.step.retrying':
          case 'thinking.delta':
          case 'tool.call.started':
          case 'tool.call.delta':
          case 'tool.result':
          case 'tool.progress':
          case 'hook.result':
          case 'agent.status.updated':
          case 'background.task.started':
          case 'background.task.terminated':
          case 'compaction.blocked':
          case 'compaction.cancelled':
          case 'compaction.completed':
          case 'compaction.started':
          case 'cron.fired':
          case 'goal.updated':
          case 'mcp.server.status':
          case 'session.meta.updated':
          case 'skill.activated':
          case 'subagent.completed':
          case 'subagent.failed':
          case 'subagent.spawned':
          case 'tool.list.updated':
          case 'turn.started':
          case 'turn.step.completed':
          case 'warning':
            return;
        }
      });

      session.prompt(prompt).catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
    });

  try {
    await runSingleTurn();
    turnCount = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const { cost, tokens } = await extractUsage(session);
    return {
      success: false,
      output: assistantText || message,
      cost,
      tokens,
      turnCount,
    };
  }

  const { cost, tokens } = await extractUsage(session);
  return {
    success: true,
    output: assistantText,
    cost,
    tokens,
    turnCount,
  };
}

interface ResolvedHeadlessSession {
  readonly session: Session;
  readonly resumed: boolean;
  readonly restorePermission: () => Promise<void>;
  readonly telemetryModel?: string;
  readonly goalModel?: string;
}

async function resolveHeadlessSession(
  harness: KimiHarness,
  workDir: string,
  defaultModel: string | undefined,
  setRestorePermission: (restorePermission: () => Promise<void>) => void,
): Promise<ResolvedHeadlessSession> {
  const sessions = await harness.listSessions({ workDir });
  const previous = sessions[0];
  if (previous !== undefined) {
    const session = await harness.resumeSession({ id: previous.id });
    const status = await session.getStatus();
    const restorePermission = await forceHeadlessPermission(
      session,
      status.permission,
      setRestorePermission,
    );
    installHeadlessHandlers(session);
    return {
      session,
      resumed: true,
      restorePermission,
      telemetryModel: configuredModel(undefined, status.model, defaultModel),
      goalModel: configuredModel(undefined, status.model),
    };
  }

  const model = requireConfiguredModel(undefined, defaultModel);
  const session = await harness.createSession({ workDir, model, permission: 'auto' });
  installHeadlessHandlers(session);
  return {
    session,
    resumed: false,
    restorePermission: async () => {},
    telemetryModel: model,
    goalModel: model,
  };
}

async function forceHeadlessPermission(
  session: Session,
  previousPermission: SessionStatus['permission'],
  setRestorePermission: (restorePermission: () => Promise<void>) => void,
): Promise<() => Promise<void>> {
  let overridePermission: Promise<void> | undefined;
  const restorePermission = async () => {
    await overridePermission?.catch(() => {});
    if (previousPermission !== 'auto') {
      await session.setPermission(previousPermission);
    }
  };
  setRestorePermission(restorePermission);
  if (previousPermission !== 'auto') {
    overridePermission = session.setPermission('auto');
    await overridePermission;
  }
  return restorePermission;
}

function requireConfiguredModel(...models: readonly (string | undefined)[]): string {
  const model = configuredModel(...models);
  if (model === undefined) {
    throw new Error(
      'No model configured. Run `kimi` and use /login to sign in, then retry; or set default_model in config.toml.',
    );
  }
  return model;
}

function configuredModel(...models: readonly (string | undefined)[]): string | undefined {
  return models.find((model) => model !== undefined && model.trim().length > 0);
}

function installHeadlessHandlers(session: Session): void {
  session.setApprovalHandler(() => ({ decision: 'approved' }));
  session.setQuestionHandler(() => null);
}

function installHeadlessTerminationCleanup(
  promptProcess: NodeJS.Process,
  cleanup: () => Promise<void>,
): () => void {
  let terminating = false;
  const exitAfterCleanup = async (signal: NodeJS.Signals): Promise<void> => {
    if (terminating) return;
    terminating = true;
    try {
      await cleanup();
    } finally {
      promptProcess.exit(signal === 'SIGINT' ? 130 : 143);
    }
  };
  const onSigint = () => exitAfterCleanup('SIGINT');
  const onSigterm = () => exitAfterCleanup('SIGTERM');
  promptProcess.once('SIGINT', onSigint);
  promptProcess.once('SIGTERM', onSigterm);
  return () => {
    promptProcess.off('SIGINT', onSigint);
    promptProcess.off('SIGTERM', onSigterm);
  };
}

async function extractUsage(session: Session): Promise<{ cost: number; tokens: number }> {
  try {
    const usage = await session.getUsage();
    const total = usage.total;
    if (total === undefined) {
      return { cost: 0, tokens: 0 };
    }
    const tokens = total.inputOther + total.inputCacheRead + total.inputCacheCreation + total.output;
    return { cost: 0, tokens };
  } catch {
    return { cost: 0, tokens: 0 };
  }
}

function hasTurnId(event: Event): event is Event & { readonly turnId: number } {
  return 'turnId' in event;
}

function formatTurnEndedFailure(event: Extract<Event, { type: 'turn.ended' }>): string {
  if (event.error !== undefined) return `${event.error.code}: ${event.error.message}`;
  return `Prompt turn ended with reason: ${event.reason}`;
}
