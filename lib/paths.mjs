/* 自动生成，请勿直接编辑。源文件：deploy/pack-mcp.mjs */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = (() => {
  try { return path.dirname(fileURLToPath(import.meta.url)); } catch { return process.cwd(); }
})();

/* 包内布局固定：<pkg>/lib/paths.mjs + <pkg>/data/**，不需要 api/paths.mjs 那套有界搜根。
   FS_DATA_ROOT 仍然可以覆盖（自建部署想把数据放别处时用）。 */
export const DATA_ROOT = process.env.FS_DATA_ROOT
  ? path.resolve(process.env.FS_DATA_ROOT)
  : path.resolve(HERE, '..', 'data');

/** 与 api/paths.mjs 同签名：dataPath('standards', 'latest.json') */
export function dataPath(...parts) {
  return path.join(DATA_ROOT, ...parts);
}
