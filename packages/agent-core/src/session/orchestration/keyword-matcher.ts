import type { SkillDefinition, SkillRegistry } from '../../skill';

/**
 * Maps keywords to agent profiles and skills.
 * When the orchestrator detects these keywords in the work context,
 * it recommends the matching agent profile and/or skills.
 */
export interface KeywordAgentMapping {
  readonly keywords: readonly string[];
  readonly agentProfile: string;
  readonly description: string;
  readonly priority: number;
}

export interface KeywordSkillMapping {
  readonly keywords: readonly string[];
  readonly skillName: string;
  readonly priority: number;
}

/** Default keyword → agent profile mappings for common work types. */
export const DEFAULT_KEYWORD_AGENT_MAPPINGS: readonly KeywordAgentMapping[] = [
  {
    keywords: ['explore', 'find', 'discover', 'map out', 'understand', 'survey', 'audit', 'analyze codebase', 'search for'],
    agentProfile: 'explore',
    description: 'Explore the codebase or domain to gather information',
    priority: 1,
  },
  {
    keywords: ['implement', 'build', 'create', 'code', 'write', 'refactor', 'fix bug', 'add feature', 'develop', 'programming'],
    agentProfile: 'coder',
    description: 'Write or modify code to implement a feature or fix',
    priority: 1,
  },
  {
    keywords: ['plan', 'design', 'architecture', 'structure', 'organize', 'roadmap', 'strategy', 'approach', 'how should we'],
    agentProfile: 'plan',
    description: 'Create a plan or architecture before implementation',
    priority: 1,
  },
  {
    keywords: ['test', 'testing', 'verify', 'validate', 'assert', 'spec', 'jest', 'vitest', 'pytest', 'unit test', 'e2e'],
    agentProfile: 'test',
    description: 'Write or run tests to verify behavior',
    priority: 1,
  },
  {
    keywords: ['security', 'vulnerability', 'vulnerabilities', 'crypto', 'sanitize', 'xss', 'sql injection', 'owasp', 'encrypt', 'csrf', 'brute force'],
    agentProfile: 'security',
    description: 'Audit or fix security issues',
    priority: 0,
  },
  {
    keywords: ['performance', 'optimize', 'slow', 'latency', 'memory leak', 'bottleneck', 'bundle size', 'cache', 'profil'],
    agentProfile: 'performance',
    description: 'Profile and optimize performance',
    priority: 0,
  },
  {
    keywords: ['ui', 'frontend', 'component', 'css', 'html', 'react', 'vue', 'tailwind', 'design system', 'responsive', 'accessibility', 'a11y'],
    agentProfile: 'frontend',
    description: 'Build or refine UI components and frontend code',
    priority: 1,
  },
  {
    keywords: ['review', 'code review', 'pr review', 'audit code', 'check quality', 'lint', 'typecheck'],
    agentProfile: 'reviewer',
    description: 'Review code for correctness, style, and issues',
    priority: 1,
  },
];

/** Extract keywords from a text string (goal title, task description, prompt). */
export function extractKeywords(text: string): string[] {
  const normalized = text.toLowerCase();
  // Extract individual words and meaningful phrases
  const words = normalized
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);

  // Also extract common multi-word patterns
  const phrases: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    phrases.push(`${words[i]} ${words[i + 1]}`);
  }

  return [...new Set([...words, ...phrases])];
}

/** Score how well a text matches a set of keywords. Returns 0–1. */
export function keywordMatchScore(text: string, keywords: readonly string[]): number {
  const textKeywords = extractKeywords(text);
  const textSet = new Set(textKeywords);
  let matches = 0;
  for (const kw of keywords) {
    const kwLower = kw.toLowerCase();
    // Exact match
    if (textSet.has(kwLower)) {
      matches++;
      continue;
    }
    // Substring match (handles pluralization and conjugation)
    for (const textKw of textSet) {
      if (textKw.includes(kwLower) || kwLower.includes(textKw)) {
        matches++;
        break;
      }
    }
  }
  return keywords.length > 0 ? matches / keywords.length : 0;
}

/** Recommend the best agent profile for a given work description. */
export function recommendAgentProfile(
  workDescription: string,
  mappings: readonly KeywordAgentMapping[] = DEFAULT_KEYWORD_AGENT_MAPPINGS,
): { profile: string; score: number; description: string } | undefined {
  let best: { profile: string; rawScore: number; description: string; priority: number } | undefined;

  for (const mapping of mappings) {
    const rawScore = keywordMatchScore(workDescription, mapping.keywords);
    if (rawScore > 0) {
      if (
        best === undefined ||
        rawScore > best.rawScore ||
        (rawScore === best.rawScore && mapping.priority < best.priority)
      ) {
        best = {
          profile: mapping.agentProfile,
          rawScore,
          description: mapping.description,
          priority: mapping.priority,
        };
      }
    }
  }

  if (best === undefined || best.rawScore < 0.1) return undefined;
  return { profile: best.profile, score: best.rawScore, description: best.description };
}

/** Recommend skills from the registry based on keyword matching. */
export function recommendSkillsForWork(
  workDescription: string,
  registry: SkillRegistry,
  minScore = 0.1,
): Array<{ skill: SkillDefinition; score: number }> {
  const textKeywords = extractKeywords(workDescription);
  const textSet = new Set(textKeywords);
  const allSkills = registry.listSkills();
  const results: Array<{ skill: SkillDefinition; score: number }> = [];

  for (const skill of allSkills) {
    // Build keyword corpus from skill name, description, and tags
    const tags = Array.isArray(skill.metadata?.['tags']) ? (skill.metadata['tags'] as string[]).join(' ') : '';
    const skillText = `${skill.name} ${skill.description} ${tags}`.toLowerCase();
    const skillWords = skillText.split(/[^\w]+/).filter((w) => w.length > 2);
    const skillSet = new Set(skillWords);

    let matches = 0;
    for (const kw of textSet) {
      if (skillSet.has(kw)) {
        matches++;
      }
    }

    const score = textSet.size > 0 ? matches / textSet.size : 0;
    if (score >= minScore) {
      results.push({ skill, score });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 5);
}
