import { watch } from 'node:fs';
import { resolve } from 'node:path';

import { log } from '@moonshot-ai/kimi-code-sdk';

import { runHeadless, type HeadlessResult } from './runner';

export interface WatchOptions {
  paths: string[];
  prompt: string;
  debounceMs?: number;
  ignorePatterns?: string[];
}

export interface WatcherHandle {
  stop: () => void;
}

export function startWatcher(options: WatchOptions): WatcherHandle {
  const debounceMs = options.debounceMs ?? 2000;
  const ignorePatterns = options.ignorePatterns ?? [
    'node_modules',
    '.git',
    'dist',
    'build',
    '.next',
    '.cache',
    '*.log',
  ];
  const cwd = process.cwd();

  const watchers: ReturnType<typeof watch>[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let running = false;
  let stopped = false;

  const shouldIgnore = (filePath: string): boolean => {
    for (const pattern of ignorePatterns) {
      if (pattern.includes('*')) {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        if (regex.test(filePath)) return true;
      } else if (filePath.includes(pattern)) {
        return true;
      }
    }
    return false;
  };

  const runPrompt = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    log.info('[watch] Running headless prompt');
    console.log('[watch] Triggering headless execution…');
    try {
      const result = await runHeadless({
        prompt: options.prompt,
        cwd,
        outputFormat: 'text',
      });
      if (result.success) {
        console.log('[watch] Success');
        if (result.output.length > 0) {
          console.log(result.output);
        }
      } else {
        console.error('[watch] Failed:', result.output);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[watch] Error:', message);
    } finally {
      running = false;
    }
  };

  const onChange = (filePath: string): void => {
    if (stopped) return;
    if (shouldIgnore(filePath)) return;

    const existing = timers.get(filePath);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      timers.delete(filePath);
      log.info('[watch] File changed', { path: filePath });
      console.log(`[watch] Detected change: ${filePath}`);
      void runPrompt();
    }, debounceMs);
    timers.set(filePath, timer);
  };

  for (const rawPath of options.paths) {
    const resolvedPath = resolve(cwd, rawPath);
    try {
      const watcher = watch(resolvedPath, { recursive: true }, (_eventType, filename) => {
        const changedPath = filename !== null ? resolve(resolvedPath, filename) : resolvedPath;
        onChange(changedPath);
      });
      watchers.push(watcher);
      console.log(`[watch] Watching: ${resolvedPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[watch] Failed to watch ${resolvedPath}:`, message);
    }
  }

  return {
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      for (const watcher of watchers) {
        watcher.close();
      }
      console.log('[watch] Stopped');
    },
  };
}
