/**
 * SessionHealthMonitor — lightweight metrics for token burn rate, context
 * pressure, and turn health.
 *
 * Samples are kept in a fixed-size ring to avoid unbounded growth.
 */

import { grandTotal, type TokenUsage } from '@moonshot-ai/kosong';

export interface UsageSample {
  readonly timestamp: number;
  readonly totalTokens: number;
}

export interface TurnSample {
  readonly timestamp: number;
  readonly durationMs: number;
  readonly steps: number;
  readonly failed: boolean;
}

export interface HealthSnapshot {
  readonly tokenBurnRatePerMin: number;
  readonly avgTurnDurationMs: number;
  readonly avgStepsPerTurn: number;
  readonly errorRate: number;
  readonly totalTurns: number;
  readonly totalErrors: number;
  readonly windowMinutes: number;
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_SAMPLES = 200;

export class SessionHealthMonitor {
  private usageSamples: UsageSample[] = [];
  private turnSamples: TurnSample[] = [];
  private totalTokensAccumulated = 0;

  recordUsage(_model: string, usage: TokenUsage): void {
    const totalTokens = grandTotal(usage);
    this.totalTokensAccumulated += totalTokens;
    this.usageSamples.push({
      timestamp: Date.now(),
      totalTokens: this.totalTokensAccumulated,
    });
    if (this.usageSamples.length > MAX_SAMPLES) {
      this.usageSamples.shift();
    }
  }

  recordTurn(durationMs: number, steps: number, failed: boolean): void {
    this.turnSamples.push({
      timestamp: Date.now(),
      durationMs,
      steps,
      failed,
    });
    if (this.turnSamples.length > MAX_SAMPLES) {
      this.turnSamples.shift();
    }
  }

  /** Lightweight check — returns true if recent turns show degradation signals. */
  checkDegraded(windowMs = DEFAULT_WINDOW_MS): boolean {
    const snapshot = this.snapshot(windowMs);
    if (snapshot.totalTurns < 3) return false;
    if (snapshot.errorRate > 0.3) return true;
    if (snapshot.tokenBurnRatePerMin > 5000) return true;
    if (snapshot.avgTurnDurationMs > 120000) return true;
    if (snapshot.avgStepsPerTurn > 15) return true;
    return false;
  }

  snapshot(windowMs = DEFAULT_WINDOW_MS): HealthSnapshot {
    const now = Date.now();
    const cutoff = now - windowMs;

    // Burn rate: slope of totalTokens over the window
    const recentUsage = this.usageSamples.filter((s) => s.timestamp >= cutoff);
    let tokenBurnRatePerMin = 0;
    if (recentUsage.length >= 2) {
      const first = recentUsage[0]!;
      const last = recentUsage.at(-1)!;
      const deltaTokens = last.totalTokens - first.totalTokens;
      const deltaMinutes = (last.timestamp - first.timestamp) / 60000;
      tokenBurnRatePerMin = deltaMinutes > 0 ? deltaTokens / deltaMinutes : 0;
    }

    const recentTurns = this.turnSamples.filter((s) => s.timestamp >= cutoff);
    const totalTurns = this.turnSamples.length;
    const totalErrors = this.turnSamples.filter((s) => s.failed).length;

    const avgTurnDurationMs =
      recentTurns.length > 0
        ? recentTurns.reduce((sum, s) => sum + s.durationMs, 0) / recentTurns.length
        : 0;

    const avgStepsPerTurn =
      recentTurns.length > 0
        ? recentTurns.reduce((sum, s) => sum + s.steps, 0) / recentTurns.length
        : 0;

    const errorRate = totalTurns > 0 ? totalErrors / totalTurns : 0;

    return {
      tokenBurnRatePerMin: Math.round(tokenBurnRatePerMin),
      avgTurnDurationMs: Math.round(avgTurnDurationMs),
      avgStepsPerTurn: Math.round(avgStepsPerTurn * 100) / 100,
      errorRate: Math.round(errorRate * 100) / 100,
      totalTurns,
      totalErrors,
      windowMinutes: windowMs / 60000,
    };
  }

  recommendation(snapshot: HealthSnapshot): string {
    const parts: string[] = [];
    if (snapshot.tokenBurnRatePerMin > 5000) {
      parts.push(
        `High token burn rate (${snapshot.tokenBurnRatePerMin}/min). Consider using more targeted prompts or subagents.`,
      );
    }
    if (snapshot.errorRate > 0.2) {
      parts.push(
        `Elevated error rate (${Math.round(snapshot.errorRate * 100)}%). Review recent failures and consider adjusting model or prompts.`,
      );
    }
    if (snapshot.avgTurnDurationMs > 120000) {
      parts.push(
        `Turns are averaging ${Math.round(snapshot.avgTurnDurationMs / 1000)}s. Consider breaking tasks into smaller subagent calls.`,
      );
    }
    if (snapshot.avgStepsPerTurn > 15) {
      parts.push(
        `High step count per turn (${snapshot.avgStepsPerTurn}). Review tool call patterns for deduplication or batching opportunities.`,
      );
    }
    if (parts.length === 0) {
      return 'Session health is nominal.';
    }
    return parts.join(' ');
  }
}
