#!/usr/bin/env node
/**
 * Kimi Project MCP Server — minimal project memory MCP.
 * Reads from and writes to `.kimi-code/memory/` graph state and
 * markdown mirror files.
 *
 * Communicates over stdio using the Model Context Protocol (JSON-RPC 2.0).
 */

const { readFile, writeFile, readdir } = require('node:fs/promises');
const path = require('node:path');

const PROJECT_ROOT = process.env.KIMI_PROJECT_ROOT ?? process.cwd();
const MEMORY_DIR = path.join(PROJECT_ROOT, '.kimi-code', 'memory');
const GRAPH_PATH = path.join(MEMORY_DIR, 'graph-state.json');

// Startup diagnostics — written to stderr so MCP clients capture it in failure messages
process.stderr.write(
  `[kimi-project] started — cwd=${process.cwd()} KIMI_PROJECT_ROOT=${process.env.KIMI_PROJECT_ROOT ?? '(unset)'} PROJECT_ROOT=${PROJECT_ROOT}\n`
);

// ---------------------------------------------------------------------------
// Protocol helpers
// ---------------------------------------------------------------------------

function send(message) {
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, data } });
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function readMemory({ category, filename }) {
  const dir = category ? path.join(MEMORY_DIR, category) : MEMORY_DIR;
  const files = await readdir(dir).catch(() => []);
  if (filename) {
    const target = path.join(dir, filename);
    const content = await readFile(target, 'utf-8').catch(() => null);
    if (content === null) return { content: [{ type: 'text', text: `File not found: ${filename}` }] };
    return { content: [{ type: 'text', text: content }] };
  }
  const entries = [];
  for (const f of files.filter((f) => f.endsWith('.md'))) {
    const content = await readFile(path.join(dir, f), 'utf-8').catch(() => '');
    entries.push(`--- ${f} ---\n${content}`);
  }
  return { content: [{ type: 'text', text: entries.join('\n\n') }] };
}

async function writeMemory({ filename, content, append = false }) {
  const target = path.join(MEMORY_DIR, filename);
  if (append) {
    const existing = await readFile(target, 'utf-8').catch(() => '');
    await writeFile(target, existing + '\n' + content, 'utf-8');
  } else {
    await writeFile(target, content, 'utf-8');
  }
  return { content: [{ type: 'text', text: `Wrote ${filename}` }] };
}

async function graphQuery({ queryType, nodeId, nodeType: _nodeType, label }) {
  let graph;
  try {
    graph = JSON.parse(await readFile(GRAPH_PATH, 'utf-8'));
  } catch {
    return { content: [{ type: 'text', text: 'Graph state not found.' }] };
  }

  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];

  if (queryType === 'list_nodes') {
    const limit = Math.min(nodes.length, 50);
    const summary = nodes.slice(0, limit).map((n) => `${n.id} [${n.type}]: ${n.label}`).join('\n');
    return { content: [{ type: 'text', text: `Nodes (${limit}/${nodes.length}):\n${summary}` }] };
  }

  if (queryType === 'get_node') {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return { content: [{ type: 'text', text: `Node ${nodeId} not found.` }] };
    return { content: [{ type: 'text', text: JSON.stringify(node, null, 2) }] };
  }

  if (queryType === 'search') {
    const term = (label ?? '').toLowerCase();
    const matches = nodes.filter((n) => {
      const nodeLabel = (n.label ?? '').toLowerCase();
      const nodeSummary = (n.summary ?? '').toLowerCase();
      return [nodeLabel, nodeSummary].some((s) => s.includes(term));
    });
    const summary = matches.slice(0, 20).map((n) => `${n.id} [${n.type}]: ${n.label}`).join('\n');
    return { content: [{ type: 'text', text: `Matches (${matches.length}):\n${summary}` }] };
  }

  if (queryType === 'neighbors') {
    const related = edges
      .filter((e) => e.source === nodeId || e.target === nodeId)
      .map((e) => {
        const otherId = e.source === nodeId ? e.target : e.source;
        const other = nodes.find((n) => n.id === otherId);
        return `${e.relation} → ${otherId}${other ? ` (${other.label})` : ''}`;
      });
    return { content: [{ type: 'text', text: `Neighbors of ${nodeId}:\n${related.join('\n')}` }] };
  }

  return { content: [{ type: 'text', text: `Unknown queryType: ${queryType}` }] };
}

async function listMemoryCategories() {
  let entries;
  try {
    entries = await readdir(MEMORY_DIR);
  } catch {
    return { content: [{ type: 'text', text: 'No .kimi-code/memory directory.' }] };
  }
  const dirs = [];
  for (const e of entries) {
    const stat = await require('node:fs/promises').stat(path.join(MEMORY_DIR, e)).catch(() => null);
    if (stat?.isDirectory()) dirs.push(e);
  }
  const files = entries.filter((e) => e.endsWith('.md')).toSorted();
  return {
    content: [{
      type: 'text',
      text: `Categories: ${dirs.length > 0 ? dirs.join(', ') : 'none'}\nTop-level md files: ${files.length > 0 ? files.join(', ') : 'none'}`,
    }],
  };
}

const TOOLS = [
  {
    name: 'kimi_read_memory',
    description: 'Read memory entries from .kimi-code/memory/ markdown mirrors.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Optional subdirectory under .kimi-code/memory/' },
        filename: { type: 'string', description: 'Optional specific .md file to read.' },
      },
    },
  },
  {
    name: 'kimi_write_memory',
    description: 'Write or append to a .kimi-code/memory/ markdown mirror file.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Target .md filename under .kimi-code/memory/' },
        content: { type: 'string', description: 'Markdown content to write.' },
        append: { type: 'boolean', description: 'Append instead of overwrite.' },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'kimi_graph_query',
    description: 'Query the project-local ontology graph in .kimi-code/memory/graph-state.json.',
    inputSchema: {
      type: 'object',
      properties: {
        queryType: {
          type: 'string',
          enum: ['list_nodes', 'get_node', 'search', 'neighbors'],
          description: 'Query operation.',
        },
        nodeId: { type: 'string', description: 'Required for get_node and neighbors.' },
        nodeType: { type: 'string', description: 'Filter by node type.' },
        label: { type: 'string', description: 'Search term for search query.' },
      },
      required: ['queryType'],
    },
  },
  {
    name: 'kimi_list_memory',
    description: 'List available memory categories and top-level markdown files.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

const HANDLERS = {
  kimi_read_memory: readMemory,
  kimi_write_memory: writeMemory,
  kimi_graph_query: graphQuery,
  kimi_list_memory: listMemoryCategories,
};

// ---------------------------------------------------------------------------
// Message loop
// ---------------------------------------------------------------------------

let buffer = '';
let contentLength = null;

async function handleRequest(request) {
  const { id, method, params } = request;

  if (method === 'initialize') {
    sendResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'kimi-project', version: '0.1.0' },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'tools/list') {
    sendResult(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    const handler = HANDLERS[name];
    if (!handler) {
      sendError(id, -32601, `Tool not found: ${name}`);
      return;
    }
    try {
      const result = await handler(args ?? {});
      sendResult(id, result);
    } catch (error) {
      sendError(id, -32603, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  sendError(id, -32601, `Method not found: ${method}`);
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf-8');

  while (true) {
    if (contentLength === null) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = buffer.slice(0, headerEnd);
      buffer = buffer.slice(headerEnd + 4);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) continue;
      contentLength = parseInt(match[1], 10);
    }

    if (buffer.length < contentLength) break;
    const message = buffer.slice(0, contentLength);
    buffer = buffer.slice(contentLength);
    contentLength = null;

    try {
      const request = JSON.parse(message);
      void handleRequest(request);
    } catch {
      // Ignore malformed JSON
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});
