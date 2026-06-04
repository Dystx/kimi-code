/**
 * SessionLearningEngine — Hermes-style learning mechanism.
 *
 * Analyzes session outcomes to detect recurring patterns, generate draft
 * skill suggestions, and propose SOUL.md / memory updates.
 *
 * Learning loop:
 *   Agent acts → outcomes tracked → reflection written
 *   → learning engine analyzes patterns → draft skills proposed
 *   → human reviews → skills promoted → next session uses them
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'pathe';
import type { SessionOutcomeTracker, PerformanceSnapshot } from './outcome-tracker';

export interface DraftSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly sourcePattern: string;
  readonly body: string;
  readonly confidence: 'low' | 'medium' | 'high';
}

export interface LearningReport {
  readonly draftSkills: DraftSkill[];
  readonly soulSuggestions: string[];
  readonly memorySuggestions: string[];
  readonly patterns: DetectedPattern[];
}

export interface DetectedPattern {
  readonly type: 'tool-sequence' | 'subagent-preference' | 'error-avoidance';
  readonly description: string;
  readonly occurrences: number;
  readonly successRate: number;
}

const DRAFTS_DIR = '.omk/skill-drafts';

export class SessionLearningEngine {
  private readonly draftsDir: string;

  constructor(
    private readonly homedir: string,
    private readonly outcomeTracker: SessionOutcomeTracker,
  ) {
    this.draftsDir = join(homedir, DRAFTS_DIR);
  }

  /**
   * Analyze the current session and produce a learning report.
   */
  async analyze(): Promise<LearningReport> {
    const snapshot = this.outcomeTracker.snapshot(24 * 60 * 60 * 1000); // 24h window
    const patterns = this.detectPatterns(snapshot);
    const draftSkills = await this.generateDraftSkills(patterns);
    const soulSuggestions = this.generateSoulSuggestions(patterns);
    const memorySuggestions = this.generateMemorySuggestions(patterns);

    return { draftSkills, soulSuggestions, memorySuggestions, patterns };
  }

  /**
   * Write draft skills to disk for later review.
   */
  async writeDrafts(report: LearningReport): Promise<void> {
    await mkdir(this.draftsDir, { recursive: true });
    for (const draft of report.draftSkills) {
      const path = join(this.draftsDir, `${draft.id}.md`);
      const content = this.renderDraftSkill(draft);
      await writeFile(path, content, 'utf-8');
    }
  }

  /**
   * List all draft skills waiting for review.
   */
  async listDrafts(): Promise<DraftSkill[]> {
    try {
      const entries = await readdir(this.draftsDir);
      const drafts: DraftSkill[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const content = await readFile(join(this.draftsDir, entry), 'utf-8');
        const parsed = this.parseDraftSkill(content, entry.slice(0, -3));
        if (parsed !== undefined) drafts.push(parsed);
      }
      return drafts;
    } catch {
      return [];
    }
  }

  /**
   * Promote a draft skill to the active skills directory.
   */
  async promoteDraft(draftId: string, skillName: string): Promise<string> {
    const draftPath = join(this.draftsDir, `${draftId}.md`);
    const skillDir = join(this.homedir, 'skills', skillName);
    const skillPath = join(skillDir, 'SKILL.md');
    await mkdir(skillDir, { recursive: true });
    await rename(draftPath, skillPath);
    return skillPath;
  }

  private detectPatterns(snapshot: PerformanceSnapshot): DetectedPattern[] {
    const patterns: DetectedPattern[] = [];

    // Detect reliable tool sequences (tools with high success and multiple uses)
    for (const tool of snapshot.topTools) {
      if (tool.count >= 3 && tool.errorRate === 0) {
        patterns.push({
          type: 'tool-sequence',
          description: `Reliable use of ${tool.name} (${tool.count} calls, 0% error)`,
          occurrences: tool.count,
          successRate: 1,
        });
      }
    }

    // Detect subagent preferences
    for (const sub of snapshot.topSubagents) {
      if (sub.count >= 2 && sub.errorRate < 0.2) {
        patterns.push({
          type: 'subagent-preference',
          description: `Reliable subagent profile "${sub.name}" (${sub.count} spawns, ${Math.round((1 - sub.errorRate) * 100)}% success)`,
          occurrences: sub.count,
          successRate: 1 - sub.errorRate,
        });
      }
    }

    // Detect error-avoidance patterns
    for (const tool of snapshot.topTools) {
      if (tool.count >= 3 && tool.errorRate > 0.3) {
        patterns.push({
          type: 'error-avoidance',
          description: `Tool "${tool.name}" has ${Math.round(tool.errorRate * 100)}% error rate (${tool.count} calls) — needs validation or better inputs`,
          occurrences: tool.count,
          successRate: 1 - tool.errorRate,
        });
      }
    }

    return patterns;
  }

  private async generateDraftSkills(patterns: DetectedPattern[]): Promise<DraftSkill[]> {
    const drafts: DraftSkill[] = [];
    const seen = new Set<string>();

    for (const pattern of patterns) {
      if (pattern.type === 'tool-sequence' && pattern.successRate === 1) {
        const match = pattern.description.match(/Reliable use of (\S+)/);
        const toolName = match?.[1] ?? 'tool';
        const id = `reliable-${toolName.toLowerCase()}`;
        if (seen.has(id)) continue;
        seen.add(id);

        drafts.push({
          id,
          name: `Use ${toolName} effectively`,
          description: `Pattern for reliably using ${toolName} based on ${pattern.occurrences} successful executions`,
          sourcePattern: pattern.description,
          body: `When using ${toolName}, ensure:\n- Validate inputs before calling\n- Handle edge cases in the result\n- Verify the outcome with a follow-up check`,
          confidence: pattern.occurrences >= 5 ? 'high' : 'medium',
        });
      }

      if (pattern.type === 'subagent-preference' && pattern.successRate >= 0.8) {
        const match = pattern.description.match(/profile "([^"]+)"/);
        const profileName = match?.[1] ?? 'subagent';
        const id = `prefer-${profileName.toLowerCase()}`;
        if (seen.has(id)) continue;
        seen.add(id);

        drafts.push({
          id,
          name: `Prefer ${profileName} subagent`,
          description: `When to delegate to the ${profileName} subagent based on success patterns`,
          sourcePattern: pattern.description,
          body: `Consider using the ${profileName} subagent when:\n- The task matches its specialty\n- You need isolated context for the work\n- Parallel execution would speed up results`,
          confidence: pattern.occurrences >= 3 ? 'high' : 'medium',
        });
      }
    }

    return drafts;
  }

  private generateSoulSuggestions(patterns: DetectedPattern[]): string[] {
    const suggestions: string[] = [];

    for (const pattern of patterns) {
      if (pattern.type === 'error-avoidance') {
        const match = pattern.description.match(/Tool "([^"]+)"/);
        const toolName = match ? match[1] : 'tool';
        suggestions.push(
          `Always validate inputs before calling ${toolName} (observed ${Math.round((1 - pattern.successRate) * 100)}% error rate).`,
        );
      }
    }

    return suggestions;
  }

  private generateMemorySuggestions(patterns: DetectedPattern[]): string[] {
    const suggestions: string[] = [];

    for (const pattern of patterns) {
      if (pattern.type === 'subagent-preference' && pattern.successRate >= 0.8) {
        const match = pattern.description.match(/profile "([^"]+)"/);
        const profileName = match?.[1] ?? 'subagent';
        suggestions.push(
          `${profileName} subagent is reliable for its specialty (${Math.round(pattern.successRate * 100)}% success over ${pattern.occurrences} uses).`,
        );
      }
    }

    return suggestions;
  }

  private renderDraftSkill(draft: DraftSkill): string {
    return `---\nname: ${draft.name}\ndescription: ${draft.description}\nconfidence: ${draft.confidence}\nsource: ${draft.sourcePattern}\n---\n\n# ${draft.name}\n\n${draft.body}\n`;
  }

  private parseDraftSkill(content: string, id: string): DraftSkill | undefined {
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const descMatch = content.match(/^description:\s*(.+)$/m);
    const confMatch = content.match(/^confidence:\s*(low|medium|high)$/m);
    const sourceMatch = content.match(/^source:\s*(.+)$/m);
    if (!nameMatch || !descMatch) return undefined;

    const bodyStart = content.indexOf('# ');
    const body = bodyStart >= 0 ? content.slice(bodyStart).trim() : '';

    return {
      id,
      name: nameMatch[1]?.trim() ?? '',
      description: descMatch[1]?.trim() ?? '',
      sourcePattern: sourceMatch?.[1]?.trim() ?? '',
      body,
      confidence: (confMatch?.[1] ?? 'low') as DraftSkill['confidence'],
    };
  }
}
