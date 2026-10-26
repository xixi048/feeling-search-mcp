#!/usr/bin/env node
/**
 * feeling-search-mcp —— 把远端 MCP 端点接到只支持 stdio 的客户端上。
 *
 * 为什么是一个「桥」而不是把服务端整个搬进包里：词表与匹配逻辑是同一份，
 * 远端 /mcp 已经是它的唯一实现。再复制一份进 npm 包，迟早两边漂移；
 * 而且语料属于站点的商业资产，不该跟着包分发。
 *
 * 协议要点（MCP stdio）：
 *   - 一行一个 JSON-RPC 消息（newline-delimited），不是 LSP 的 Content-Length 头
 *   - stdout 只能出协议消息，任何日志必须走 stderr，否则客户端解析会炸
 *   - 通知（无 id）不回包，远端返回 202 空体，这里也必须什么都不写
 */

import process from 'node:process';
import readline from 'node:readline';

const DEFAULT_ENDPOINT = 'https://xiximm.cloud/mcp';
const VERSION = '0.1.0';

/* ------------------------------ 参数 ------------------------------ */

function parseArgs(argv) {
  const out = { endpoint: process.env.FS_MCP_URL || DEFAULT_ENDPOINT, timeout: 30000, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--endpoint' || a === '-e') out.endpoint = argv[++i] || out.endpoint;
    else if (a.startsWith('--endpoint=')) out.endpoint = a.slice(11);
    else if (a === '--timeout') out.timeout = Number(argv[++i]) || out.timeout;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-v') out.version = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  process.stderr.write(`feeling-search-mcp ${VERSION}

把感觉检索的远端 MCP 端点接到 stdio 客户端。

用法：
  feeling-search-mcp [--endpoint <url>] [--timeout <ms>]

环境变量：
  FS_MCP_URL      覆盖端点地址（默认 ${DEFAULT_ENDPOINT}）
  FS_MCP_TOKEN    端点要求鉴权时带上 Bearer <token>

MCP 客户端配置：
  { "mcpServers": { "feeling-search": { "command": "npx", "args": ["-y", "feeling-search-mcp"] } } }
`);
  process.exit(0);
}

if (args.version) {
  process.stderr.write(VERSION + '\n');
  process.exit(0);
}

const TOKEN = (process.env.FS_MCP_TOKEN || '').trim();

function log(...parts) {
  process.stderr.write('[feeling-search-mcp] ' + parts.join(' ') + '\n');
}

/* ------------------------------ 转发 ------------------------------ */

async function forward(msg) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeout);

  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
  };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;

  try {
    const res = await fetch(args.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(msg),
      signal: controller.signal,
    });

    const text = await res.text();

    /* 通知 / 全通知批次：远端回 202 + 空体，不能往 stdout 写任何东西 */
    if (res.status === 202 || !text.trim()) return null;

    if (!res.ok) {
      return rpcError(msg, -32000, `远端返回 HTTP ${res.status}`, text.slice(0, 400));
    }

    try {
      return JSON.parse(text);
    } catch {
      return rpcError(msg, -32700, '远端返回的不是合法 JSON', text.slice(0, 200));
    }
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return rpcError(
      msg,
      -32000,
      aborted ? `请求超时（${args.timeout}ms）` : '无法连接远端端点',
      `${args.endpoint}${e && e.message ? ' · ' + e.message : ''}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/* 只为「需要回包」的请求造错误；通知不该产生响应 */
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

/* ------------------------------ 主循环 ------------------------------ */

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

/* 串行处理：客户端是按顺序发请求的，并发回包会让某些实现错配请求与响应 */
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

    const out = await forward(msg);
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  }).catch((e) => {
    log('处理失败：', e && e.message ? e.message : String(e));
  });
});

rl.on('close', () => {
  queue.finally(() => process.exit(0));
});

log(`已启动，端点 ${args.endpoint}${TOKEN ? '（带鉴权）' : ''}`);
