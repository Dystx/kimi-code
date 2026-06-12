/* eslint-disable import/first -- vi.mock setup must run before the imports it stubs out. */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
  spawnSync: mocks.spawnSync,
}));

import { createGitStatusCache, formatGitBadge } from '#/utils/git/git-status';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function mockExecFileSync(stdoutByArgs: Map<string, string>, fallbackError = true) {
  mocks.execFile.mockImplementation(
    (_cmd: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      const key = args.join(' ');
      if (stdoutByArgs.has(key)) {
        callback(null, stdoutByArgs.get(key)!, '');
      } else if (key.includes('pr view')) {
        callback(new Error('no pull request'), '', '');
      } else if (fallbackError) {
        callback(new Error('unexpected execFile call'), '', '');
      }
    },
  );
}

describe('git status cache', () => {
  it('caches branch and status reads until their TTL expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));

    mocks.spawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) {
        return { status: 0, stdout: 'true\n' };
      }
      return { status: 1, stdout: '' };
    });

    mockExecFileSync(
      new Map([
        ['-C /tmp/repo branch --show-current', 'main\n'],
        ['-C /tmp/repo status --porcelain -b', '## main...origin/main [ahead 2, behind 1]\n M src/app.ts\n'],
        ['-C /tmp/repo diff --numstat HEAD --', '4\t1\tsrc/app.ts\n'],
      ]),
    );

    const cache = createGitStatusCache('/tmp/repo');

    // First synchronous read returns the cached default while async git
    // reads are still in flight.
    expect(cache.getStatus()).toEqual({
      branch: null,
      dirty: false,
      ahead: 0,
      behind: 0,
      diffAdded: 0,
      diffDeleted: 0,
      pullRequest: null,
    });

    // Async reads have not resolved yet. Branch and status are started
    // synchronously; diff is scheduled after status resolves in a microtask.
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    expect(mocks.execFile).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(0);

    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: true,
      ahead: 2,
      behind: 1,
      diffAdded: 4,
      diffDeleted: 1,
      pullRequest: null,
    });

    // Second call within TTL uses cached branch/status, but now that the
    // branch is known the PR lookup starts asynchronously.
    cache.getStatus();
    expect(mocks.execFile).toHaveBeenCalledTimes(4);

    vi.setSystemTime(new Date('2026-04-24T00:00:06Z'));
    cache.getStatus();
    expect(mocks.execFile).toHaveBeenCalledTimes(5);

    vi.setSystemTime(new Date('2026-04-24T00:00:16Z'));
    cache.getStatus();
    // Status read starts synchronously; diff is scheduled in a microtask.
    expect(mocks.execFile).toHaveBeenCalledTimes(6);
  });

  it('reads uncommitted diff line counts and current pull request metadata', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();

    mocks.spawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) {
        return { status: 0, stdout: 'true\n' };
      }
      return { status: 1, stdout: '' };
    });

    mocks.execFile.mockImplementation(
      (_cmd: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        if (args.join(' ').includes('pr view')) {
          callback(null, '{"number":12,"url":"https://github.com/acme/repo/pull/12"}\n', '');
          return;
        }
        if (args.includes('branch')) {
          callback(null, 'feature/footer\n', '');
          return;
        }
        if (args.includes('status')) {
          callback(null, '## feature/footer...origin/feature/footer\n M src/app.ts\n', '');
          return;
        }
        if (args.includes('diff')) {
          callback(null, '10\t3\tsrc/app.ts\n-\t-\timage.png\n0\t5\tdeleted.ts\n', '');
          return;
        }
        callback(new Error('unexpected execFile call'), '', '');
      },
    );

    const cache = createGitStatusCache('/tmp/repo', { onChange });

    // Before async reads resolve the cache exposes default values.
    expect(cache.getStatus()).toEqual({
      branch: null,
      dirty: false,
      ahead: 0,
      behind: 0,
      diffAdded: 0,
      diffDeleted: 0,
      pullRequest: null,
    });

    await vi.advanceTimersByTimeAsync(0);

    // Branch/status/diff are now populated; PR lookup was not started yet
    // because the first getStatus() saw branch === null.
    // Branch and status resolve in separate microtasks, so onChange fires
    // once for each changed value.
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(cache.getStatus()).toEqual({
      branch: 'feature/footer',
      dirty: true,
      ahead: 0,
      behind: 0,
      diffAdded: 10,
      diffDeleted: 8,
      pullRequest: null,
    });

    // A subsequent getStatus() kicks off the PR lookup now that branch is known.
    cache.getStatus();
    await vi.advanceTimersByTimeAsync(0);

    expect(onChange).toHaveBeenCalledTimes(3);
    expect(cache.getStatus()).toEqual({
      branch: 'feature/footer',
      dirty: true,
      ahead: 0,
      behind: 0,
      diffAdded: 10,
      diffDeleted: 8,
      pullRequest: {
        number: 12,
        url: 'https://github.com/acme/repo/pull/12',
      },
    });
  });

  it('keeps footer git status working when git commands throw synchronously', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();

    mocks.spawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) {
        return { status: 0, stdout: 'true\n' };
      }
      return { status: 1, stdout: '' };
    });

    mocks.execFile.mockImplementation(() => {
      const error = Object.assign(new Error('spawn ENOTDIR'), { code: 'ENOTDIR' });
      throw error;
    });

    const cache = createGitStatusCache('/tmp/repo', { onChange });

    expect(cache.getStatus()).toEqual({
      branch: null,
      dirty: false,
      ahead: 0,
      behind: 0,
      diffAdded: 0,
      diffDeleted: 0,
      pullRequest: null,
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(onChange).not.toHaveBeenCalled();
    expect(cache.getStatus()).toEqual({
      branch: null,
      dirty: false,
      ahead: 0,
      behind: 0,
      diffAdded: 0,
      diffDeleted: 0,
      pullRequest: null,
    });
  });

  it('returns null when the working directory is not a git repo and formats badges', () => {
    mocks.spawnSync.mockReturnValue({ status: 1, stdout: '' });
    expect(createGitStatusCache('/tmp/not-a-repo').getStatus()).toBeNull();
    expect(
      formatGitBadge({
        branch: 'main',
        dirty: true,
        ahead: 2,
        behind: 1,
        diffAdded: 12,
        diffDeleted: 3,
        pullRequest: null,
      }),
    ).toBe('main [+12 -3 ↑2↓1]');
    expect(
      formatGitBadge({
        branch: 'main',
        dirty: true,
        ahead: 0,
        behind: 0,
        diffAdded: 0,
        diffDeleted: 0,
        pullRequest: null,
      }),
    ).toBe('main [±]');
  });

  it('formats pull request badges as terminal hyperlinks when requested', () => {
    const linked = formatGitBadge(
      {
        branch: 'feature/footer',
        dirty: false,
        ahead: 0,
        behind: 0,
        diffAdded: 0,
        diffDeleted: 0,
        pullRequest: {
          number: 12,
          url: 'https://github.com/acme/repo/pull/12',
        },
      },
      { linkPullRequest: true },
    );

    expect(linked).toContain('[PR#12]');
    expect(linked).toContain('\u001B]8;;https://github.com/acme/repo/pull/12\u0007');
    expect(linked).toContain('\u001B]8;;\u0007');
  });

  it('does not spawn duplicate git reads while a refresh is pending', async () => {
    vi.useFakeTimers();

    mocks.spawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) {
        return { status: 0, stdout: 'true\n' };
      }
      return { status: 1, stdout: '' };
    });

    let branchCallback: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;
    mocks.execFile.mockImplementation(
      (_cmd: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        if (args.join(' ').includes('branch')) {
          branchCallback = callback;
          return;
        }
        if (args.join(' ').includes('status')) {
          // leave status refresh pending
          return;
        }
        callback(new Error('unexpected execFile call'), '', '');
      },
    );

    const cache = createGitStatusCache('/tmp/repo');
    cache.getStatus();
    cache.getStatus();
    cache.getStatus();

    // Only one branch read and one status read should have started.
    expect(mocks.execFile).toHaveBeenCalledTimes(2);

    branchCallback?.(null, 'main\n', '');
    await vi.advanceTimersByTimeAsync(0);

    expect(cache.getStatus()?.branch).toBe('main');
  });
});
