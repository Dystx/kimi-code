export { MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE } from '@moonshot-ai/protocol';

export type {
  AgentEvent,
  AgentStatusUpdatedEvent,
  AssistantDeltaEvent,
  BackgroundTaskStartedEvent,
  BackgroundTaskTerminatedEvent,
  CompactionBlockedEvent,
  CompactionCancelledEvent,
  CompactionCompletedEvent,
  CompactionResult,
  CompactionStartedEvent,
  CronFiredEvent,
  ErrorEvent,
  Event,
  GoalUpdatedEvent,
  HookResultEvent,
  McpOAuthAuthorizationUrlUpdateData,
  McpServerStatusEvent,
  McpServerStatusPayload,
  SessionMetaUpdatedEvent,
  SkillActivatedEvent,
  SubagentCompletedEvent,
  SubagentFailedEvent,
  SubagentSpawnedEvent,
  SubagentStartedEvent,
  SubagentSuspendedEvent,
  ThinkingDeltaEvent,
  ToolCallDeltaEvent,
  ToolCallStartedEvent,
  ToolInputDisplay,
  ToolListUpdatedEvent,
  ToolListUpdatedReason,
  ToolProgressEvent,
  ToolResultEvent,
  ToolUpdate,
  TurnEndedEvent,
  TurnEndReason,
  TurnStartedEvent,
  TurnStepCompletedEvent,
  TurnStepInterruptedEvent,
  TurnStepRetryingEvent,
  TurnStepStartedEvent,
  UsageStatus,
  WarningEvent,
} from '@moonshot-ai/protocol';

export type { KimiErrorPayload } from '../errors';

// Fork-specific event types not yet in upstream protocol package.
import type { SessionStatusSnapshot } from '../session/status';

export interface SessionStatusUpdatedEvent {
  readonly type: 'session.status';
  readonly snapshot: SessionStatusSnapshot;
}

export interface SubagentProgressEvent {
  readonly type: 'subagent.progress';
  readonly subagentId: string;
  readonly parentToolCallId: string;
  readonly preview: string;
  readonly usage?: TokenUsage | undefined;
  readonly contextTokens?: number | undefined;
}

// Re-export TokenUsage so consumers don't need to import from protocol directly.
export type { TokenUsage } from '@moonshot-ai/protocol';
