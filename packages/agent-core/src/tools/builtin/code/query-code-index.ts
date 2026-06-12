import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { Kaos } from '@moonshot-ai/kaos';
import { join } from 'pathe';

export const QueryCodeIndexInputSchema = z.object({
  query: z.string().describe('Search query — matches against file paths, symbols, and summaries'),
  language: z.string().optional().describe('Filter by language (e.g. "typescript", "python")'),
  max_results: z.number().int().min(1).max(50).optional().default(10).describe('Maximum results to return'),
});

export type QueryCodeIndexInput = z.infer<typeof QueryCodeIndexInputSchema>;

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

export class QueryCodeIndexTool implements BuiltinTool<QueryCodeIndexInput> {
  readonly name = 'QueryCodeIndex' as const;
  readonly description =
    'Query the codebase index built by BuildCodeIndex. Searches file paths, symbols, and summaries for matches. Much faster than grep for finding where things are defined. If no index exists, returns an error suggesting you run BuildCodeIndex first.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(QueryCodeIndexInputSchema);

  constructor(private readonly kaos: Kaos) {}

  resolveExecution(args: QueryCodeIndexInput): ToolExecution {
    return {
      description: `Querying code index: ${args.query}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private async execution(args: QueryCodeIndexInput): Promise<ExecutableToolResult> {
    const cwd = this.kaos.getcwd();
    const indexPath = join(cwd, '.kimi-code', 'code-index.json');

    let index: CodeIndex;
    try {
      const raw = await this.kaos.readText(indexPath);
      index = JSON.parse(raw) as CodeIndex;
    } catch {
      return {
        isError: true,
        output: 'No code index found. Run BuildCodeIndex first to create a searchable index of the codebase.',
      };
    }

    const query = args.query.toLowerCase();
    const queryTerms = query.split(/\s+/).filter((t) => t.length > 1);

    const scored = index.entries
      .filter((entry) => args.language === undefined || entry.language === args.language)
      .map((entry) => {
        let score = 0;
        const text = `${entry.path} ${entry.symbols.join(' ')} ${entry.summary}`.toLowerCase();

        // Exact match in path is highest value
        if (entry.path.toLowerCase().includes(query)) score += 10;

        // Symbol matches are high value
        for (const symbol of entry.symbols) {
          if (symbol.toLowerCase().includes(query)) score += 8;
        }

        // Term frequency in full text
        for (const term of queryTerms) {
          const regex = new RegExp(term, 'g');
          const matches = text.match(regex);
          if (matches !== null) {
            score += matches.length * 2;
          }
        }

        return { entry, score };
      })
      .filter((s) => s.score > 0)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, args.max_results);

    if (scored.length === 0) {
      return { output: `No matches found for "${args.query}" in the code index.` };
    }

    const lines: string[] = [
      `## Code Index Results for "${args.query}" (${scored.length} matches)`,
      `Index built: ${index.builtAt}`,
      '',
    ];

    for (const { entry, score } of scored) {
      lines.push(`### ${entry.path} (score: ${score}, ${entry.lines} lines)`);
      lines.push(`Language: ${entry.language}`);
      if (entry.symbols.length > 0) {
        lines.push(`Symbols: ${entry.symbols.slice(0, 15).join(', ')}${entry.symbols.length > 15 ? '...' : ''}`);
      }
      if (entry.summary.length > 0) {
        lines.push('');
        lines.push('```');
        lines.push(entry.summary);
        lines.push('```');
      }
      lines.push('');
    }

    return { output: lines.join('\n') };
  }
}
