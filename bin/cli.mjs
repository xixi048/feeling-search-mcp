#!/usr/bin/env node
/**
 * feeling-search-mcp —— 感觉检索的 MCP 服务端
 *
 * 两种形态：
 *   ① 本地（默认）：包里带词表 + 中文引擎 + 英文引擎，**不联网**。
 *      词表命中走词典（微秒级），整句零命中走语义引擎（毫秒级）。
 *   ② 远端（--remote）：把请求转发给 https://xiximm.cloud/mcp，行为与 0.1.x 一致，
 *      适合不想装 20MB 数据、或者要跟着站点数据实时更新的场景。
 *
 * 为什么默认本地：远端每次调用都是一次跨网往返 + 云端冷启动（实测 0.76–1.64 秒），
 * 本地是 5–90 毫秒；而且文本不出机器。
 *
 * 协议要点（MCP stdio）：
 *   - 一行一个 JSON-RPC 消息（newline-delimited），不是 LSP 的 Content-Length 头
 *   - stdout 只能出协议消息，任何日志必须走 stderr，否则客户端解析会炸
 *   - 通知（无 id）不回包
 */

import process from 'node:process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const DATA = path.resolve(PKG_ROOT, 'data');

const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch { return '0.0.0'; }
})();

const DEFAULT_ENDPOINT = 'https://xiximm.cloud/mcp';

/* ------------------------------ 参数 ------------------------------ */

function parseArgs(argv) {
  const out = {
    remote: false,
    endpoint: process.env.FS_MCP_URL || DEFAULT_ENDPOINT,
    timeout: 30000,
    data: process.env.FS_DATA_ROOT || DATA,
    selfTest: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--remote' || a === '-r') out.remote = true;
    else if (a === '--local' || a === '-l') out.remote = false;
    else if (a === '--endpoint' || a === '-e') out.endpoint = argv[++i] || out.endpoint;
    else if (a.startsWith('--endpoint=')) out.endpoint = a.slice(11);
    else if (a === '--timeout') out.timeout = Number(argv[++i]) || out.timeout;
    else if (a === '--data') out.data = path.resolve(argv[++i] || out.data);
    else if (a === '--self-test') out.selfTest = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-v') out.version = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function log(...parts) {
  process.stderr.write('[feeling-search-mcp] ' + parts.join(' ') + '\n');
}

if (args.help) {
  process.stderr.write(`feeling-search-mcp ${VERSION}

感觉检索 MCP 服务端。默认完全本地：词表 + 中文引擎 + 英文引擎，不联网。

用法：
  feeling-search-mcp                    # 本地（默认）：5–90ms，文本不出机器
  feeling-search-mcp --remote           # 转发到站点端点（要联网）
  feeling-search-mcp --self-test        # 跑一遍自检并退出

选项：
  -r, --remote            走远端端点
  -e, --endpoint <url>    远端地址（默认 ${DEFAULT_ENDPOINT}）
      --timeout <ms>      远端超时（默认 30000）
      --data <dir>        数据目录（默认包内 data/）
  -v, --version           打印版本
  -h, --help              打印本帮助

环境变量：
  FS_MCP_URL      覆盖远端地址
  FS_MCP_TOKEN    远端要求鉴权时带 Bearer <token>
  FS_DATA_ROOT    覆盖数据目录
  FS_ENGINE_DIR   显式指定引擎数据根（默认就是 --data 指向的目录）

MCP 客户端配置：
  { "mcpServers": { "feeling-search": { "command": "npx", "args": ["-y", "feeling-search-mcp"] } } }
`);
  process.exit(0);
}

if (args.version) {
  process.stderr.write(VERSION + '\n');
  process.exit(0);
}

/* ------------------------------ 远端形态 ------------------------------ */

const TOKEN = (process.env.FS_MCP_TOKEN || '').trim();

function rpcError(msg, code, message, detail) {
  const items = Array.isArray(msg) ? msg : [msg];
  const replies = items
    .filter((m) => m && typeof m === 'object' && m.id !== undefined && m.id !== null)
    .map((m) => ({
      jsonrpc: '2.0',
      id: m.id,
      error: { code, message: detail ? `${message}：${detail}` : message },
    }));
  if (!replies.length) return null;
  return Array.isArray(msg) ? replies : replies[0];
}

async function forward(msg) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeout);
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  try {
    const res = await fetch(args.endpoint, {
      method: 'POST', headers, body: JSON.stringify(msg), signal: controller.signal,
    });
    const text = await res.text();
    if (res.status === 202 || !text.trim()) return null;
    if (!res.ok) return rpcError(msg, -32000, `远端返回 HTTP ${res.status}`, text.slice(0, 400));
    try { return JSON.parse(text); } catch { return rpcError(msg, -32700, '远端返回的不是合法 JSON', text.slice(0, 200)); }
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return rpcError(msg, -32000,
      aborted ? `请求超时（${args.timeout}ms）` : '无法连接远端端点',
      `${args.endpoint}${e && e.message ? ' · ' + e.message : ''}`);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ 本地形态 ------------------------------ */

let LOCAL = null;

async function local() {
  if (LOCAL) return LOCAL;
  /* 引擎层只看 FS_ENGINE_DIR：设了就启用，没设就是纯词典 */
  process.env.FS_ENGINE_DIR = args.data;
  process.env.FS_DATA_ROOT = args.data;
  const mod = await import('../lib/tools.mjs');
  LOCAL = mod;
  return mod;
}

async function handleLocal(msg) {
  const mod = await local();
  const isBatch = Array.isArray(msg);
  const items = isBatch ? msg : [msg];
  const replies = [];

  for (const m of items) {
    if (!m || typeof m !== 'object') continue;
    const isNotification = m.id === undefined || m.id === null;

    if (m.method === 'initialize') {
      replies.push({
        jsonrpc: '2.0', id: m.id,
        result: {
          protocolVersion: mod.PROTOCOL_VERSION || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'feeling-search', version: VERSION },
          instructions: mod.INSTRUCTIONS || '',
        },
      });
      continue;
    }
    if (m.method === 'notifications/initialized' || m.method === 'notifications/cancelled') continue;
    if (m.method === 'ping') { if (!isNotification) replies.push({ jsonrpc: '2.0', id: m.id, result: {} }); continue; }

    if (m.method === 'tools/list') {
      replies.push({
        jsonrpc: '2.0', id: m.id,
        result: {
          tools: mod.TOOLS.map((t) => ({
            name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
          })),
        },
      });
      continue;
    }

    if (m.method === 'tools/call') {
      const name = m.params && m.params.name;
      const a = (m.params && m.params.arguments) || {};
      const out = await mod.callTool(name, a);
      replies.push({ jsonrpc: '2.0', id: m.id, result: out });
      continue;
    }

    if (!isNotification) {
      replies.push({
        jsonrpc: '2.0', id: m.id,
        error: { code: -32601, message: `未实现的方法 ${m.method}` },
      });
    }
  }

  if (!replies.length) return null;
  return isBatch ? replies : replies[0];
}

/* ------------------------------ 自检 ------------------------------ */

if (args.selfTest) {
  const t0 = Date.now();
  const mod = await local();
  log(`数据目录 ${args.data}`);
  const cases = [
    ['压抑', { text: '压抑' }],
    ['不要压抑', { text: '不要压抑' }],
    ['中文整句', { text: '雨里旧香港那种潮湿的夜' }],
    ['英文整句', { text: 'moody rainy night in old Hong Kong' }],
    ['词典命中', { text: '安静但是有点孤独' }],
  ];
  for (const [label, a] of cases) {
    const t = Date.now();
    const r = await mod.callTool('word_analyze', a);
    const body = JSON.parse(r.content[0].text);
    log(`${label.padEnd(10)} ${String(Date.now() - t).padStart(4)}ms  source=${body.source} engine=${body.engine || '-'} ` +
        `词=${(body.words || []).slice(0, 3).map((w) => w.w).join('/') || '空'} ` +
        `风格=${(body.styles || []).slice(0, 2).map((s) => s.name).join('/') || '空'}`);
  }
  log(`自检完成，共 ${Date.now() - t0}ms`);
  process.exit(0);
}

/* ------------------------------ 主循环 ------------------------------ */

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();

rl.on('line', (line) => {
  const raw = line.trim();
  if (!raw) return;
  queue = queue.then(async () => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32700, message: 'Parse error：这一行不是合法 JSON' },
      }) + '\n');
      return;
    }
    const out = args.remote ? await forward(msg) : await handleLocal(msg);
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  }).catch((e) => {
    log('处理失败：', e && e.message ? e.message : String(e));
  });
});

rl.on('close', () => {
  queue.finally(() => process.exit(0));
});

log(args.remote
  ? `已启动（远端），端点 ${args.endpoint}${TOKEN ? '（带鉴权）' : ''}`
  : `已启动（本地），数据 ${args.data} —— 不联网`);
