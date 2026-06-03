import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { Kaos } from '@moonshot-ai/kaos';
import { join } from 'pathe';

export const BuildCodeIndexInputSchema = z.object({
  directories: z
    .array(z.string())
    .optional()
    .describe('Directories to index (defaults to current working directory)'),
  include: z
    .array(z.string())
    .optional()
    .default(['**/*.{ts,tsx,js,jsx,py,go,rs,java,kt,swift}'])
    .describe('Glob patterns for files to include'),
  exclude: z
    .array(z.string())
    .optional()
    .default(['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/__pycache__/**', '**/*.min.js'])
    .describe('Glob patterns for files to exclude'),
});

export type BuildCodeIndexInput = z.infer<typeof BuildCodeIndexInputSchema>;

interface CodeIndexEntry {
  readonly path: string;
  readonly language: string;
  readonly lines: number;
  readonly symbols: string[];
  readonly summary: string;
}

interface CodeIndex {
  readonly builtAt: string;
  readonly entries: CodeIndexEntry[];
}

const LANGUAGE_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
};

// Simple regex-based symbol extraction
const PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)/gm,
    /^(?:export\s+)?(?:abstract\s+)?(?:class|interface)\s+(\w+)/gm,
    /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]/gm,
    /^(?:export\s+)?type\s+(\w+)\s*[=;]/gm,
  ],
  python: [
    /^(?:async\s+)?def\s+(\w+)\s*\(/gm,
    /^class\s+(\w+)\s*[:\(]/gm,
  ],
  go: [
    /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/gm,
    /^type\s+(\w+)\s+/gm,
  ],
  rust: [
    /^(?:pub\s+)?fn\s+(\w+)\s*\(/gm,
    /^(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/gm,
  ],
  java: [
    /^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:abstract\s+)?(?:class|interface|enum)\s+(\w+)/gm,
    /^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:\w+[<>\[\]\s]*)+\s+(\w+)\s*\(/gm,
  ],
};

export class BuildCodeIndexTool implements BuiltinTool<BuildCodeIndexInput> {
  readonly name = 'BuildCodeIndex' as const;
  readonly description =
    'Build a searchable index of the codebase. Scans source files, extracts symbols (functions, classes, types), and writes an index to .kimi-code/code-index.json. Use this before large exploration tasks so agents can query the index instead of grepping everywhere.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(BuildCodeIndexInputSchema);

  constructor(private readonly kaos: Kaos) {}

  resolveExecution(args: BuildCodeIndexInput): ToolExecution {
    return {
      description: `Building code index`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private async execution(args: BuildCodeIndexInput): Promise<ExecutableToolResult> {
    const cwd = this.kaos.getcwd();
    const dirs = args.directories ?? [cwd];
    const entries: CodeIndexEntry[] = [];

    for (const dir of dirs) {
      for (const pattern of args.include) {
        for await (const filePath of this.kaos.glob(dir, pattern)) {
          // Check exclude patterns
          const isExcluded = args.exclude.some((ex) => {
            const regex = ex.replace(/\*\*/g, '<<<STARSTAR>>>').replace(/\*/g, '[^/]*').replace(/<<<STARSTAR>>>/g, '.*');
            return new RegExp(regex).test(filePath);
          });
          if (isExcluded) continue;

          try {
            const content = await this.kaos.readText(filePath);
            const ext = filePath.split('.').pop() ?? '';
            const language = LANGUAGE_MAP[ext] ?? ext;
            const lines = content.split('\n');
            const symbols = extractSymbols(content, language);
            entries.push({
              path: filePath,
              language,
              lines: lines.length,
              symbols: symbols.slice(0, 50), // Cap symbols per file
              summary: lines.slice(0, 5).join('\n').trim(),
            });
          } catch {
            // Skip unreadable files
          }
        }
      }
    }

    const index: CodeIndex = {
      builtAt: new Date().toISOString(),
      entries,
    };

    const indexPath = join(cwd, '.kimi-code', 'code-index.json');
    await this.kaos.mkdir(join(cwd, '.kimi-code'), { parents: true, existOk: true });
    await this.kaos.writeText(indexPath, JSON.stringify(index, null, 2));

    return {
      output: `Indexed ${entries.length} files. Index written to ${indexPath}.`,
    };
  }
}

function extractSymbols(content: string, language: string): string[] {
  const patterns = PATTERNS[language] ?? [];
  const symbols = new Set<string>();
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      if (name !== undefined && name.length > 0) {
        symbols.add(name);
      }
    }
  }
  return Array.from(symbols);
}
