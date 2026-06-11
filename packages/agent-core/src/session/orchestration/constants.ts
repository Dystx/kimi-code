/** Maximum number of deduplication keys to retain before evicting oldest. */
export const MAX_DEDUP_SIZE = 1000;
/** Maximum events in queue before dropping oldest. */
export const MAX_QUEUE_SIZE = 100;
/** Default cooldown per event type in milliseconds. */
export const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
/** Maximum total injected characters per drain. */
export const MAX_INJECTION_SIZE = 8000;
/** Maximum events to keep in rolling history. */
export const MAX_HISTORY_SIZE = 20;
/** Maximum times a skill can be injected before it's suppressed as repetitive. */
export const MAX_SKILL_REPETITION = 3;
/** Minimum keyword match score to recommend an agent profile (0-1). */
export const DEFAULT_AGENT_REC_THRESHOLD = 0.3;
/** Minimum keyword match score to show a skill in recommendations (0-1). */
export const DEFAULT_SKILL_REC_THRESHOLD = 0.2;
/** Minimum keyword match score to inject a skill's full content (0-1). */
export const DEFAULT_SKILL_INJECT_THRESHOLD = 0.25;
