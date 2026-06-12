import { watch } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { startWatcher } from '#/headless/watcher';

vi.mock('node:fs', () => ({
  watch: vi.fn(),
}));

describe('startWatcher', () => {
  it('creates watchers for each path', () => {
    const watcherMock = { close: vi.fn() };
    vi.mocked(watch).mockReturnValue(watcherMock as unknown as ReturnType<typeof watch>);

    const handle = startWatcher({
      paths: ['./src', './lib'],
      prompt: 'test prompt',
    });

    expect(watch).toHaveBeenCalledTimes(2);
    expect(watch).toHaveBeenCalledWith(expect.stringContaining('src'), { recursive: true }, expect.any(Function));
    expect(watch).toHaveBeenCalledWith(expect.stringContaining('lib'), { recursive: true }, expect.any(Function));

    handle.stop();
    expect(watcherMock.close).toHaveBeenCalledTimes(2);
  });

  it('ignores matched patterns', () => {
    const watcherMock = { close: vi.fn() };
    vi.mocked(watch).mockReturnValue(watcherMock as unknown as ReturnType<typeof watch>);

    const handle = startWatcher({
      paths: ['./src'],
      prompt: 'test',
      ignorePatterns: ['node_modules', '*.log'],
    });

    // Get the watch callback
    const watchCallback = (
      vi.mocked(watch).mock.calls[0] as unknown as [
        string,
        { recursive: boolean },
        (eventType: string, filename: string | null) => void,
      ]
    )[2];

    // Should not crash on ignored files
    watchCallback('change', 'node_modules/foo.ts');
    watchCallback('change', 'debug.log');

    // Non-ignored files should set up timers
    watchCallback('change', 'src/index.ts');

    expect(handle.stop).not.toThrow();
    handle.stop();
  });

  it('is idempotent on stop', () => {
    const watcherMock = { close: vi.fn() };
    vi.mocked(watch).mockReturnValue(watcherMock as unknown as ReturnType<typeof watch>);

    const handle = startWatcher({
      paths: ['./src'],
      prompt: 'test',
    });

    handle.stop();
    handle.stop();
    expect(watcherMock.close).toHaveBeenCalledTimes(1);
  });
});
