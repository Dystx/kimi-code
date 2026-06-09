import { execFile, type ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

export interface SandboxOptions {
  image: string;
  timeoutMs: number;
  memoryLimit: string;
  networkDisabled: boolean;
  bindMounts: Array<{ host: string; container: string }>;
}

const DEFAULT_SANDBOX_OPTIONS: SandboxOptions = {
  image: '',
  timeoutMs: 30_000,
  memoryLimit: '512m',
  networkDisabled: true,
  bindMounts: [],
};

const LANGUAGE_IMAGES: Record<string, string> = {
  python: 'python:3-slim',
  javascript: 'node:20-slim',
};

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function executeInSandbox(
  code: string,
  language: 'python' | 'javascript',
  options: Partial<SandboxOptions>,
  signal?: AbortSignal,
): Promise<SandboxResult> {
  const opts = { ...DEFAULT_SANDBOX_OPTIONS, ...options };
  const image = opts.image || LANGUAGE_IMAGES[language];
  if (image === undefined) {
    throw new Error(`No Docker image configured for language: ${language}`);
  }

  const tmpDir = join(tmpdir(), `kimi-sandbox-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  const scriptFile = language === 'python' ? 'script.py' : 'script.js';
  const scriptPath = join(tmpDir, scriptFile);
  await writeFile(scriptPath, code, 'utf-8');

  const args = ['run', '--rm'];

  if (opts.networkDisabled) {
    args.push('--network', 'none');
  }

  args.push('--memory', opts.memoryLimit);
  args.push('--memory-swap', opts.memoryLimit);

  for (const mount of opts.bindMounts) {
    args.push('-v', `${mount.host}:${mount.container}`);
  }

  args.push('-v', `${tmpDir}:/workspace`);
  args.push('--workdir', '/workspace');

  args.push(image);

  if (language === 'python') {
    args.push('python', scriptFile);
  } else {
    args.push('node', scriptFile);
  }

  try {
    return await new Promise<SandboxResult>((resolve, reject) => {
      let child: ChildProcess;

      const onAbort = (): void => {
        if (child !== undefined) {
          child.kill('SIGKILL');
        }
      };
      signal?.addEventListener('abort', onAbort);

      child = execFile('docker', args, { timeout: opts.timeoutMs }, (error, stdout, stderr) => {
        signal?.removeEventListener('abort', onAbort);
        if (error !== null && error.killed) {
          resolve({
            stdout,
            stderr: stderr || 'Sandbox execution timed out',
            exitCode: 124,
          });
          return;
        }
        resolve({
          stdout,
          stderr,
          exitCode: error !== null ? (error.code as number) ?? 1 : 0,
        });
      });

      child.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      });
    });
  } finally {
    void rm(tmpDir, { recursive: true, force: true });
  }
}

export async function isDockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile('docker', ['version'], { timeout: 5000 }, (error) => {
      resolve(error === null);
    });
    child.on('error', () => {
      resolve(false);
    });
  });
}
