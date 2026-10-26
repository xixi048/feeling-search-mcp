/**
 * 冒烟测试：起一个子进程跑真实的 stdio 协议，验证桥接与远端响应。
 *
 *   node test/smoke.mjs                    打远端默认端点
 *   FS_MCP_URL=http://127.0.0.1:8899/mcp node test/smoke.mjs   打本地
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

const CLI = new URL('../bin/cli.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const endpoint = process.env.FS_MCP_URL || 'https://xiximm.cloud/mcp';

const child = spawn(process.execPath, [CLI], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });

const pending = new Map();
let buffer = '';

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) { pending.delete(msg.id); resolve(msg); }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method };
  if (params !== undefined) msg.params = params;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时（15s）`)), 15000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify(msg) + '\n');
  });
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  process.stderr.write(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ' — ' + detail}\n`);
}

try {
  process.stderr.write(`端点 ${endpoint}\n\n`);

  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.1' },
  });
  check('initialize 有 serverInfo', !!init.result?.serverInfo, JSON.stringify(init).slice(0, 200));
  check('协议版本匹配', init.result?.protocolVersion === '2025-06-18', init.result?.protocolVersion);

  const list = await rpc('tools/list');
  const names = (list.result?.tools || []).map((t) => t.name);
  check('tools/list 有 5 个工具', names.length === 5, names.join(','));
  check('含 word_analyze', names.includes('word_analyze'));

  const call = await rpc('tools/call', {
    name: 'word_analyze',
    arguments: { text: '下雨天一个人走在便利店门口，冷白灯光', allow_cloud: false },
  });
  const payload = JSON.parse(call.result?.content?.[0]?.text || '{}');
  check('word_analyze 命中词', (payload.words || []).length > 0, `词 ${(payload.words || []).length}`);
  check('word_analyze 命中风格', (payload.styles || []).length > 0, `风格 ${(payload.styles || []).length}`);
  check('source 是 local', payload.source === 'local', String(payload.source));

  const bad = await rpc('tools/call', { name: 'no_such_tool', arguments: {} });
  check('未知工具返回错误', !!bad.result?.isError || !!bad.error);
} catch (e) {
  check('流程跑完', false, e.message);
} finally {
  child.stdin.end();
  child.kill();
}

const failed = checks.filter((c) => !c.ok);
process.stderr.write(`\n结果：${checks.length - failed.length} 通过 / ${failed.length} 失败\n`);
if (failed.length) {
  if (stderr.trim()) process.stderr.write(`\n--- 子进程 stderr ---\n${stderr}\n`);
  process.exit(1);
}
