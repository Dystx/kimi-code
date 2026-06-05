#!/usr/bin/env node
/**
 * OMK Project MCP Server — minimal replacement for the oh-my-kimi project
 * memory MCP. Reads from and writes to `.omk/memory/` graph state and
 * markdown mirror files.
 *
 * Communicates over stdio using the Model Context Protocol (JSON-RPC 2.0).
 */

const { readFile, writeFile, readdir } = require('node:fs/promises');
const { join, dirname } = require('node:path');
const { homedir } = require('node:os');

const PROJECT_ROOT = process.env.OMK_PROJECT_ROOT || process.cwd();
const MEMORY_DIR = join(PROJECT_ROOT, '.omk', 'memory');
const GRAPH_PATH = join(MEMORY_DIR, 'graph-state.json');

// ---------------------------------------------------------------------------
// Protocol helpers
// ---------------------------------------------------------------------------

let requestId = 0;

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

function sendNotification(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function readMemory({ category, filename }) {
  const dir = category ? join(MEMORY_DIR, category) : MEMORY_DIR;
  const files = await readdir(dir).catch(() => []);
  if (filename) {
    const target = join(dir, filename);
    const content = await readFile(target, 'utf-8').catch(() => null);
    if (content === null) return { content: [{ type: 'text', text: `File not found: ${filename}` }] };
    return { content: [{ type: 'text', text: content }] };
  }
  const entries = [];
  for (const f of files.filter((f) => f.endsWith('.md'))) {
    const content = await readFile(join(dir, f), 'utf-8').catch(() => '');
    entries.push(`--- ${f} ---\n${content}`);
  }
  return { content: [{ type: 'text', text: entries.join('\n\n') }] };
}

async function writeMemory({ filename, content, append = false }) {
  const target = join(MEMORY_DIR, filename);
  if (append) {
    const existing = await readFile(target, 'utf-8').catch(() => '');
    await writeFile(target, existing + '\n' + content, 'utf-8');
  } else {
    await writeFile(target, content, 'utf-8');
  }
  return { content: [{ type: 'text', text: `Wrote ${filename}` }] };
}

async function graphQuery({ queryType, nodeId, nodeType, label }) {
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
    const matches = nodes.filter((n) =>
      (n.label ?? '').toLowerCase().includes(term) ||
      (n.summary ?? '').toLowerCase().includes(term)
    );
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
    return { content: [{ type: 'text', text: 'No .omk/memory directory.' }] };
  }
  const dirs = [];
  for (const e of entries) {
    const stat = await require('node:fs/promises').stat(join(MEMORY_DIR, e)).catch(() => null);
    if (stat?.isDirectory()) dirs.push(e);
  }
  const files = entries.filter((e) => e.endsWith('.md')).sort();
  return {
    content: [{
      type: 'text',
      text: `Categories: ${dirs.join(', ') || 'none'}\nTop-level md files: ${files.join(', ') || 'none'}`,
    }],
  };
}

const TOOLS = [
  {
    name: 'omk_read_memory',
    description: 'Read memory entries from .omk/memory/ markdown mirrors.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Optional subdirectory under .omk/memory/' },
        filename: { type: 'string', description: 'Optional specific .md file to read.' },
      },
    },
  },
  {
    name: 'omk_write_memory',
    description: 'Write or append to a .omk/memory/ markdown mirror file.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Target .md filename under .omk/memory/' },
        content: { type: 'string', description: 'Markdown content to write.' },
        append: { type: 'boolean', description: 'Append instead of overwrite.' },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'omk_graph_query',
    description: 'Query the project-local ontology graph in .omk/memory/graph-state.json.',
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
    name: 'omk_list_memory',
    description: 'List available memory categories and top-level markdown files.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

const HANDLERS = {
  omk_read_memory: readMemory,
  omk_write_memory: writeMemory,
  omk_graph_query: graphQuery,
  omk_list_memory: listMemoryCategories,
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
      serverInfo: { name: 'omk-project', version: '0.1.0' },
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
      handleRequest(request);
    } catch {
      // Ignore malformed JSON
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});
