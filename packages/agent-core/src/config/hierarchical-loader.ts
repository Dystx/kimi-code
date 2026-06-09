import { dirname, join } from 'pathe';
import type { Kaos } from '@moonshot-ai/kaos';

export interface HierarchicalConfig {
  readonly global: string | null;
  readonly project: string | null;
  readonly subdirectory: string | null;
  readonly merged: string;
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

export async function loadHierarchicalSoulMd(kaos: Kaos): Promise<HierarchicalConfig> {
  const home = kaos.gethome();
  const cwd = kaos.getcwd();
  const globalPath = join(home, '.kimi-code', 'SOUL.md');

  const global = await readSoulMd(kaos, globalPath);
  const projectRoot = await findProjectRoot(kaos, cwd);
  const projectPath = join(projectRoot, '.kimi-code', 'SOUL.md');
  const project = await readSoulMd(kaos, projectPath);

  const subdirPath = join(cwd, '.kimi-code', 'SOUL.md');
  const subdirectory = subdirPath !== projectPath ? await readSoulMd(kaos, subdirPath) : null;

  const sections: string[] = [];
  if (global !== null) sections.push(`## Global\n\n${global}`);
  if (project !== null) sections.push(`## Project\n\n${project}`);
  if (subdirectory !== null) sections.push(`## Subdirectory\n\n${subdirectory}`);

  return {
    global,
    project,
    subdirectory,
    merged: sections.join('\n\n'),
  };
}

async function readSoulMd(kaos: Kaos, path: string): Promise<string | null> {
  try {
    const stat = await kaos.stat(path);
    if ((stat.stMode & S_IFMT) !== S_IFREG) return null;
    const content = (await kaos.readText(path, { errors: 'ignore' })).trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

async function findProjectRoot(kaos: Kaos, workDir: string): Promise<string> {
  const initial = kaos.normpath(workDir);
  let current = initial;

  while (true) {
    if (await pathExists(kaos, join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return initial;
    current = parent;
  }
}

async function pathExists(kaos: Kaos, path: string): Promise<boolean> {
  try {
    await kaos.stat(path);
    return true;
  } catch {
    return false;
  }
}
