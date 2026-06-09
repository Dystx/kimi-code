import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'pathe';

const MAX_ENTRIES = 1000;

export interface MemoryEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly tags: string[];
  readonly content: string;
  readonly source: 'reflection' | 'skill' | 'outcome';
  readonly relevanceScore?: number;
}

export class MemoryStore {
  private readonly memoryDir: string;

  constructor(baseDir: string) {
    this.memoryDir = join(baseDir, '.omk', 'memory');
  }

  async loadMemories(): Promise<MemoryEntry[]> {
    try {
      const files = await readdir(this.memoryDir);
      const memories: MemoryEntry[] = [];
      for (const file of files) {
        if (file !== 'entries.json') continue;
        const content = await readFile(join(this.memoryDir, file), 'utf-8');
        try {
          const parsed = JSON.parse(content) as unknown;
          if (Array.isArray(parsed)) {
            for (const entry of parsed) {
              if (this.isValidMemoryEntry(entry)) {
                memories.push(entry);
              }
            }
          }
        } catch {
          // Skip invalid JSON
        }
      }
      return memories.sort((a, b) => b.timestamp - a.timestamp);
    } catch {
      return [];
    }
  }

  async findRelevant(query: string, tags?: string[], limit = 10, workDirTag?: string): Promise<MemoryEntry[]> {
    const memories = await this.loadMemories();
    const queryLower = query.toLowerCase().trim();
    const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);
    const hasQuery = queryLower.length > 0 && queryWords.length > 0;

    const scored = memories.map((memory) => {
      let baseScore = 0;
      const contentLower = memory.content.toLowerCase();
      const tagsLower = memory.tags.map((t) => t.toLowerCase());

      // Exact phrase match
      if (contentLower.includes(queryLower)) baseScore += 5;

      // Word-level matches
      for (const word of queryWords) {
        if (contentLower.includes(word)) baseScore += 2;
        if (tagsLower.some((t) => t.includes(word))) baseScore += 3;
      }

      // Explicit tag filter
      let tagMatch = false;
      if (tags !== undefined) {
        for (const tag of tags) {
          if (tagsLower.includes(tag.toLowerCase())) {
            baseScore += 4;
            tagMatch = true;
          }
        }
      }

      // WorkDir affinity — boost memories tagged with current workDir
      let workDirMatch = false;
      if (workDirTag !== undefined && tagsLower.includes(workDirTag.toLowerCase())) {
        baseScore += 6;
        workDirMatch = true;
      }

      // Without a query, only return memories that have explicit tag/workDir matches
      if (!hasQuery && !tagMatch && !workDirMatch) {
        return { memory, score: 0 };
      }

      // Apply recency and source boosts only to already-relevant memories
      let score = baseScore;
      const ageDays = (Date.now() - memory.timestamp) / (1000 * 60 * 60 * 24);
      score += Math.max(0, 5 - ageDays);
      if (memory.source === 'reflection') score += 1;

      return { memory, score };
    });

    return scored
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ memory, score }) => ({ ...memory, relevanceScore: score }));
  }

  async addMemory(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): Promise<MemoryEntry> {
    const memory: MemoryEntry = {
      ...entry,
      id: randomUUID(),
      timestamp: Date.now(),
    };

    await mkdir(this.memoryDir, { recursive: true });
    const filePath = join(this.memoryDir, 'entries.json');

    let entries: MemoryEntry[] = [];
    try {
      const existing = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(existing) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (this.isValidMemoryEntry(item)) {
            entries.push(item);
          }
        }
      }
    } catch {
      // File doesn't exist or is invalid
    }

    entries.push(memory);

    // Enforce size limit: keep most recent entries
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => a.timestamp - b.timestamp);
      entries = entries.slice(-MAX_ENTRIES);
    }

    // Atomic write to avoid race conditions
    const tempPath = `${filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(entries, null, 2), 'utf-8');
    await rename(tempPath, filePath);
    return memory;
  }

  formatForInjection(memories: MemoryEntry[]): string {
    if (memories.length === 0) return '';

    const lines = ['## Cross-Session Memories', ''];

    for (const memory of memories) {
      const date = new Date(memory.timestamp).toISOString().split('T')[0];
      lines.push(`- [${date}] ${memory.content}`);
      if (memory.tags.length > 0) {
        lines.push(`  Tags: ${memory.tags.join(', ')}`);
      }
    }

    return lines.join('\n');
  }

  private isValidMemoryEntry(entry: unknown): entry is MemoryEntry {
    if (typeof entry !== 'object' || entry === null) return false;
    const e = entry as Record<string, unknown>;
    return (
      typeof e['id'] === 'string' &&
      typeof e['timestamp'] === 'number' &&
      Array.isArray(e['tags']) &&
      (e['tags'] as unknown[]).every((t: unknown) => typeof t === 'string') &&
      typeof e['content'] === 'string' &&
      (e['source'] === 'reflection' || e['source'] === 'skill' || e['source'] === 'outcome')
    );
  }
}
