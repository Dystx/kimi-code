import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'pathe';

const MAX_ENTRIES = 1000;

/** BM25 hyper-parameters. */
const BM25_K1 = 1.5;
const BM25_B = 0.75;
/** How many times each tag term is repeated in the pseudo-document. */
const TAG_WEIGHT = 3;

export interface MemoryEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly tags: string[];
  readonly content: string;
  readonly source: 'reflection' | 'skill' | 'outcome';
  readonly relevanceScore?: number;
}

interface Bm25Document {
  readonly id: string;
  readonly terms: string[];
  readonly length: number;
}

class Bm25Scorer {
  private readonly avgdl: number;
  private readonly idf: Map<string, number>;

  constructor(documents: readonly Bm25Document[]) {
    const totalLength = documents.reduce((sum, d) => sum + d.length, 0);
    this.avgdl = totalLength / documents.length || 1;

    const df = new Map<string, number>();
    for (const doc of documents) {
      const seen = new Set(doc.terms);
      for (const term of seen) {
        df.set(term, (df.get(term) ?? 0) + 1);
      }
    }

    const N = documents.length;
    this.idf = new Map();
    for (const [term, freq] of df) {
      // Lucene-style BM25 IDF — always non-negative.
      this.idf.set(term, Math.log(1 + (N - freq + 0.5) / (freq + 0.5)));
    }
  }

  score(doc: Bm25Document, queryTerms: readonly string[]): number {
    let score = 0;
    const termFreq = new Map<string, number>();
    for (const term of doc.terms) {
      termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
    }

    for (const term of queryTerms) {
      const idf = this.idf.get(term) ?? 0;
      const tf = termFreq.get(term) ?? 0;
      if (tf === 0) continue;
      const numerator = tf * (BM25_K1 + 1);
      const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / this.avgdl));
      score += idf * (numerator / denominator);
    }

    return score;
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

export class MemoryStore {
  private readonly memoryDir: string;

  constructor(baseDir: string) {
    this.memoryDir = join(baseDir, '.kimi-code', 'memory');
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
      return memories.toSorted((a, b) => b.timestamp - a.timestamp);
    } catch {
      return [];
    }
  }

  async findRelevant(
    query: string,
    tags?: string[],
    limit = 10,
    workDirTag?: string,
  ): Promise<MemoryEntry[]> {
    const memories = await this.loadMemories();
    if (memories.length === 0) return [];

    const queryTerms = tokenize(query);
    const hasQuery = queryTerms.length > 0;

    // Build BM25 documents: content + weighted tags
    const docs: Bm25Document[] = memories.map((m) => {
      const terms = tokenize(m.content);
      for (const tag of m.tags) {
        const tagTerms = tokenize(tag);
        for (let i = 0; i < TAG_WEIGHT; i++) {
          terms.push(...tagTerms);
        }
      }
      return { id: m.id, terms, length: terms.length };
    });

    const scorer = new Bm25Scorer(docs);

    const scored = memories.map((memory, index) => {
      const doc = docs[index]!;
      const tagsLower = new Set(memory.tags.map((t) => t.toLowerCase()));

      // Base relevance via BM25
      let score = hasQuery ? scorer.score(doc, queryTerms) : 0;

      // Exact phrase match adds a strong signal on top of BM25
      const queryLower = query.toLowerCase().trim();
      if (queryLower.length > 0 && memory.content.toLowerCase().includes(queryLower)) {
        score += 3;
      }

      // Explicit tag filter
      let tagMatch = false;
      if (tags !== undefined) {
        for (const tag of tags) {
          if (tagsLower.has(tag.toLowerCase())) {
            score += 2;
            tagMatch = true;
          }
        }
      }

      // WorkDir affinity
      let workDirMatch = false;
      if (workDirTag !== undefined && tagsLower.has(workDirTag.toLowerCase())) {
        score += 4;
        workDirMatch = true;
      }

      // Without a query, only return memories that have explicit tag/workDir matches
      if (!hasQuery && !tagMatch && !workDirMatch) {
        return { memory, score: 0 };
      }

      // Recency boost (decays over ~5 days)
      const ageDays = (Date.now() - memory.timestamp) / (1000 * 60 * 60 * 24);
      score += Math.max(0, 3 - ageDays * 0.5);

      // Source boost: reflections are highest-value learnings
      if (memory.source === 'reflection') score += 0.5;

      return { memory, score };
    });

    return scored
      .filter(({ score }) => score > 0)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ memory, score }) => ({ ...memory, relevanceScore: Math.round(score * 100) / 100 }));
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
