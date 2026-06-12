import { describe, it, expect } from 'vitest';
import {
  extractKeywords,
  keywordMatchScore,
  recommendAgentProfile,
  recommendSkillsForWork,
  DEFAULT_KEYWORD_AGENT_MAPPINGS,
} from '../../src/session/orchestration/keyword-matcher';
import type { SkillRegistry, SkillDefinition } from '../../src/skill';

describe('Keyword matcher', () => {
  describe('extractKeywords', () => {
    it('extracts words and phrases from text', () => {
      const result = extractKeywords('Implement a responsive React component');
      expect(result).toContain('implement');
      expect(result).toContain('responsive');
      expect(result).toContain('react');
      expect(result).toContain('component');
      expect(result).toContain('implement responsive');
      expect(result).toContain('responsive react');
      expect(result).toContain('react component');
    });

    it('filters out short words', () => {
      const result = extractKeywords('a b c to of at');
      expect(result).toHaveLength(0);
    });

    it('normalizes to lowercase', () => {
      const result = extractKeywords('React Component');
      expect(result).toContain('react');
      expect(result).toContain('component');
    });
  });

  describe('keywordMatchScore', () => {
    it('returns 1 for exact match', () => {
      const score = keywordMatchScore('implement react component', ['react', 'component']);
      expect(score).toBe(1);
    });

    it('returns 0.5 for partial match', () => {
      const score = keywordMatchScore('implement react component', ['react', 'vue']);
      expect(score).toBe(0.5);
    });

    it('returns 0 for no match', () => {
      const score = keywordMatchScore('hello world', ['react', 'vue']);
      expect(score).toBe(0);
    });
  });

  describe('recommendAgentProfile', () => {
    it('recommends coder for implementation work', () => {
      const rec = recommendAgentProfile('Implement a new authentication flow');
      expect(rec).toBeDefined();
      expect(rec!.profile).toBe('coder');
      expect(rec!.score).toBeGreaterThan(0.05);
    });

    it('recommends explore for discovery work', () => {
      const rec = recommendAgentProfile('Explore the codebase and find all API endpoints');
      expect(rec).toBeDefined();
      expect(rec!.profile).toBe('explore');
    });

    it('recommends plan for architecture work', () => {
      const rec = recommendAgentProfile('Design the architecture for a new microservice');
      expect(rec).toBeDefined();
      expect(rec!.profile).toBe('plan');
    });

    it('recommends frontend for UI work', () => {
      const rec = recommendAgentProfile('Build a responsive React component with Tailwind');
      expect(rec).toBeDefined();
      expect(rec!.profile).toBe('frontend');
    });

    it('recommends test for testing work', () => {
      const rec = recommendAgentProfile('Write unit tests for the login form');
      expect(rec).toBeDefined();
      expect(rec!.profile).toBe('test');
    });

    it('recommends security for security work', () => {
      const rec = recommendAgentProfile('Audit the auth flow for OWASP vulnerabilities');
      expect(rec).toBeDefined();
      expect(rec!.profile).toBe('security');
    });

    it('recommends performance for optimization work', () => {
      const rec = recommendAgentProfile('Optimize the bundle size and reduce memory leaks');
      expect(rec).toBeDefined();
      expect(rec!.profile).toBe('performance');
    });

    it('returns undefined for ambiguous text', () => {
      const rec = recommendAgentProfile('hello world foo bar');
      expect(rec).toBeUndefined();
    });
  });

  describe('recommendSkillsForWork', () => {
    it('recommends skills matching keywords', () => {
      const mockRegistry = {
        getSkill: (name: string) =>
          name === 'quality-gate'
            ? ({
                name: 'quality-gate',
                description: 'Run lint and typecheck',
                path: '/test',
                dir: '/test',
                content: 'test',
                metadata: {},
                source: 'builtin',
              } as SkillDefinition)
            : undefined,
        listSkills: () => [
          {
            name: 'quality-gate',
            description: 'Run lint typecheck and tests before finishing',
            path: '/test',
            dir: '/test',
            content: 'test',
            metadata: {},
            source: 'builtin',
          } as SkillDefinition,
          {
            name: 'code-review',
            description: 'Review code changes for correctness',
            path: '/test',
            dir: '/test',
            content: 'test',
            metadata: {},
            source: 'builtin',
          } as SkillDefinition,
        ],
        hasSkill: () => true,
        renderSkillPrompt: (skill: SkillDefinition) => skill.content ?? '',
        listInvocableSkills: () => [],
      } as unknown as SkillRegistry;

      const results = recommendSkillsForWork('run lint and tests on my code', mockRegistry);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.skill.name).toBe('quality-gate');
    });

    it('includes tags in matching', () => {
      const mockRegistry = {
        getSkill: () => undefined,
        listSkills: () => [
          {
            name: 'accessibility-audit',
            description: 'Check accessibility',
            path: '/test',
            dir: '/test',
            content: 'test',
            metadata: { tags: ['a11y', 'wcag', 'aria'] },
            source: 'builtin',
          } as SkillDefinition,
        ],
        hasSkill: () => true,
        renderSkillPrompt: (skill: SkillDefinition) => skill.content ?? '',
        listInvocableSkills: () => [],
      } as unknown as SkillRegistry;

      const results = recommendSkillsForWork('check wcag compliance', mockRegistry);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.skill.name).toBe('accessibility-audit');
    });

    it('returns empty array when no skills match', () => {
      const mockRegistry = {
        getSkill: () => undefined,
        listSkills: () => [
          {
            name: 'xyz-foobar',
            description: 'Something about quantum physics',
            path: '/test',
            dir: '/test',
            content: 'test',
            metadata: {},
            source: 'builtin',
          } as SkillDefinition,
        ],
        hasSkill: () => true,
        renderSkillPrompt: (skill: SkillDefinition) => skill.content ?? '',
        listInvocableSkills: () => [],
      } as unknown as SkillRegistry;

      const results = recommendSkillsForWork('basketball championship finals', mockRegistry);
      expect(results).toHaveLength(0);
    });
  });
});
