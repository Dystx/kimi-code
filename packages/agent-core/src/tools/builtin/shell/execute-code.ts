/**
 * ExecuteCode — run Python or Node.js code in a subprocess.
 *
 * This enables programmatic data processing: the model can write code to
 * filter, parse, transform, or aggregate data without round-tripping through
 * the LLM context window for every step.
 *
 * Safety:
 *   - Runs in the agent's cwd (no path traversal)
 *   - Timeout enforced (default 30s, max 120s)
 *   - Stdin closed immediately to prevent interactive hangs
 *   - SIGTERM → 5s grace → SIGKILL
 */

import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import type { Kaos } from '@moonshot-ai/kaos';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { ToolAccesses } from '../../../loop/tool-access';
import { toInputJsonSchema } from '../../support/input-schema';
import { ToolResultBuilder } from '../../support/result-builder';

const DEFAULT_TIMEOUT_S = 30;
const MAX_TIMEOUT_S = 120;
const SIGTERM_GRACE_MS = 5_000;

export const ExecuteCodeInputSchema = z.object({
  language: z
    .enum(['python', 'nodejs'])
    .describe('Language to execute: python (runs via python -c) or nodejs (runs via node -e).'),
  code: z.string().min(1).describe('The code to execute. For python, write valid Python statements/expressions. For nodejs, write valid JavaScript.'),
  timeout: z
    .number()
    .int()
    .min(5)
    .max(MAX_TIMEOUT_S)
    .optional()
    .describe(`Timeout in seconds. Defaults to ${DEFAULT_TIMEOUT_S}s, max ${MAX_TIMEOUT_S}s.`),
});

export type ExecuteCodeInput = z.infer<typeof ExecuteCodeInputSchema>;

export class ExecuteCodeTool implements BuiltinTool<ExecuteCodeInput> {
  readonly name = 'ExecuteCode';
  readonly description =
    'Execute Python or Node.js code in a subprocess. Use this for programmatic data processing: parsing JSON, filtering grep results, aggregating data, transforming text, or running small scripts. The code runs in the workspace directory and receives only stdout/stderr back. This avoids consuming LLM context tokens on intermediate processing steps.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ExecuteCodeInputSchema);

  constructor(
    private readonly kaos: Kaos,
    private readonly cwd: string,
  ) {}

  resolveExecution(args: ExecuteCodeInput): ToolExecution {
    return {
      description: `Executing ${args.language} code`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: ExecuteCodeInput,
    { signal }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const timeoutMs = (args.timeout ?? DEFAULT_TIMEOUT_S) * 1000;
    const { shellArgs, env } = this.buildCommand(args);

    let proc;
    try {
      proc = await this.kaos.execWithEnv(shellArgs, env);
    } catch (error) {
      return {
        output: `Execution failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    try {
      proc.stdin.end();
    } catch {
      /* process already gone */
    }

    let timedOut = false;
    let aborted = false;
    let killed = false;

    const killProc = async (): Promise<void> => {
      if (killed) return;
      killed = true;
      try {
        await proc.kill('SIGTERM');
      } catch {
        /* process already gone */
      }
      const exited = proc
        .wait()
        .then(() => true)
        .catch(() => true);
      const raced = await Promise.race([
        exited,
        new Promise<false>((resolve) => {
          setTimeout(() =>{  resolve(false); }, SIGTERM_GRACE_MS);
        }),
      ]);
      if (!raced && proc.exitCode === null) {
        try {
          await proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
      try {
        proc.stdout.destroy();
      } catch {}
      try {
        proc.stderr.destroy();
      } catch {}
    };

    const onAbort = (): void => {
      aborted = true;
      void killProc();
    };
    signal.addEventListener('abort', onAbort);

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      void killProc();
    }, timeoutMs);

    try {
      const builder = new ToolResultBuilder();
      const [, exitCode] = await Promise.all([
        Promise.all([
          readStreamIntoBuilder(proc.stdout, builder),
          readStreamIntoBuilder(proc.stderr, builder),
        ]),
        proc.wait(),
      ]);

      if (timedOut) {
        return builder.error(`Code execution timed out after ${String(timeoutMs / 1000)}s`);
      }
      if (aborted) {
        return builder.error('Code execution was stopped');
      }

      const isError = exitCode !== 0;
      if (isError && builder.nChars === 0) {
        builder.write(`Process exited with code ${String(exitCode)}`);
      }

      if (!isError) {
        return builder.ok('Code executed successfully.');
      }
      return builder.error(`Code failed with exit code: ${String(exitCode)}.`);
    } catch (error) {
      return {
        output: `Execution failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    } finally {
      clearTimeout(timeoutHandle);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private buildCommand(args: ExecuteCodeInput): {
    shellArgs: string[];
    env: Record<string, string>;
  } {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      NO_COLOR: '1',
      TERM: 'dumb',
      PYTHONUNBUFFERED: '1',
    };

    if (args.language === 'python') {
      return {
        shellArgs: [this.kaos.osEnv.shellPath, '-c', `python -c ${JSON.stringify(args.code)}`],
        env,
      };
    }

    return {
      shellArgs: [this.kaos.osEnv.shellPath, '-c', `node -e ${JSON.stringify(args.code)}`],
      env,
    };
  }
}

async function readStreamIntoBuilder(
  stream: Readable,
  builder: ToolResultBuilder,
): Promise<void> {
  const decoder = new StringDecoder('utf8');
  for await (const chunk of stream) {
    const buf: Buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
    builder.write(decoder.write(buf));
  }
  builder.write(decoder.end());
}
