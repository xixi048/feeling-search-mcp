/* 自动生成，请勿直接编辑。源文件：mcp/engine.mjs（node deploy/pack-mcp.mjs 同步） */
/**
 * mcp/engine.mjs —— 语义引擎层（中文 zh-engine / 英文 ternlight）
 *
 * 干什么：把一句话变成向量，再和 598 个风格向量比余弦，补上「词表一个词都没命中」的那一段。
 *
 * 为什么在 MCP 侧而不是服务端：浏览器里跑引擎用的是**用户自己的 CPU**，
 * 云函数每次请求都要冷启动重新加载权重（真机实测 +154ms / +20MB），而本地 MCP
 * 是一个常驻进程，加载一次就能一直用。同一份代码两边都能跑，差别只是谁出算力。
 *
 * 依赖约定（都由 deploy/pack-mcp.mjs 铺好，目录可移植）：
 *   <dir>/standards/zh-engine/{engine-zh.mjs, manifest.json, tokenizer.json, weights.bin, anchors-zh.json, zh_core.wasm}
 *   <dir>/standards/ternlight/{engine.js, engine.wasm}
 *   <dir>/standards/idx/{styles-zh.bin, styles.bin}
 *   <dir>/standards/{latest.json, sem-core.json}
 *
 * 零依赖：只用 node 内置模块。远端云函数不设 FS_ENGINE_DIR 就不会走到这里。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CACHE = new Map();
const read = (p) => new Uint8Array(fs.readFileSync(p));
const json = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/* ------------------------------ 语言判定 ------------------------------ */

/** 有汉字就是中文。纯英文/数字/符号走英文引擎。 */
export function detectLang(text){
  return /[\u4e00-\u9fff]/.test(String(text || '')) ? 'zh' : 'en';
}

export function engineName(lang){
  return lang === 'zh' ? 'zh-engine' : 'en-engine';
}

/* ------------------------------ 引擎加载 ------------------------------ */

async function loadZh(dir){
  const base = path.join(dir, 'standards', 'zh-engine');
  const mod = await import(pathToFileURL(path.join(base, 'engine-zh.mjs')).href);
  /* 第二个参数是 reader：给了就不走 fetch，直接从磁盘读 —— 包里没有 http 服务 */
  const eng = await mod.ZhEngine.load('/standards/zh-engine/', async (f) => read(path.join(base, f)));
  return {
    lang: 'zh',
    wasm: !!eng.wasm,
    embed: (text) => Float32Array.from(eng.embedText(text)),
    /* 27 组粗锚点：引擎包里已经算好解码好，直接给中文名与余弦 */
    anchors: (text, k = 4) => (eng.score(text) || [])
      .slice(0, k)
      .map((a) => ({ w: a.name, id: a.id, score: +a.c?.toFixed ? +a.c.toFixed(3) : +(a.cos || 0).toFixed(3) })),
  };
}

async function loadEn(dir){
  const base = path.join(dir, 'standards', 'ternlight');
  const mod = await import(pathToFileURL(path.join(base, 'engine.js')).href);
  /* wasm-bindgen 的初始化接受字节，不用 URL/fetch */
  await mod.default({ module_or_path: new Uint8Array(fs.readFileSync(path.join(base, 'engine.wasm'))) });
  const dim = mod.embed('x').length;
  return {
    lang: 'en',
    wasm: true,
    dim,
    embed: (text) => {
      const v = Float32Array.from(mod.embed(text));
      let s = 0;
      for (let i = 0; i < v.length; i++) s += v[i] * v[i];
      const n = Math.sqrt(s) || 1;
      for (let i = 0; i < v.length; i++) v[i] /= n;
      return v;
    },
    /* 英文侧没有内置锚点表，锚点走「风格向量 + 标识词」，这里只给空 */
    anchors: () => [],
  };
}

/**
 * @param {string} dir 数据根（包内 = <pkg>/data）
 * @param {'zh'|'en'} lang
 */
export function loadEngine(dir, lang){
  const key = dir + '|' + lang;
  if (!CACHE.has(key)){
    CACHE.set(key, (lang === 'zh' ? loadZh(dir) : loadEn(dir)).catch((e) => {
      CACHE.delete(key);        // 失败不缓存，下次还能重试
      throw e;
    }));
  }
  return CACHE.get(key);
}

/* ------------------------------ 风格向量 ------------------------------ */

/** 598 个风格 × 2 路（定义 / 生成提示词）的 int8 向量，q8 已做 L2 归一，除以 127 即余弦 */
function loadStyleVectors(dir, lang){
  const key = dir + '|vec|' + lang;
  if (CACHE.has(key)) return CACHE.get(key);
  const core = json(path.join(dir, 'standards', 'sem-core.json'));
  const meta = lang === 'zh' ? core.assets.stylesZh : core.assets.stylesEn;
  if (!meta) throw new Error('sem-core.json 里没有 ' + lang + ' 的风格向量');
  const buf = new Int8Array(fs.readFileSync(path.join(dir, meta.path.replace(/^standards\//, 'standards/'))).buffer.slice(0));
  const mask = Buffer.from(meta.mask, 'base64');
  const latest = json(path.join(dir, 'standards', 'latest.json'));
  const byId = Object.fromEntries(latest.styles.map((s) => [s.id, s]));
  const out = { meta, buf, mask, byId };
  CACHE.set(key, out);
  return out;
}

/** 变体去重：冻雨霓虹是霓虹雨街的变体，分数一样，只留基风格 */
function groupKey(s){
  return (s && s.parent) || (s && s.id) || '';
}

/**
 * 一句话 → 风格排名（与网页同一条打分：查询向量 vs 598 个风格向量取余弦）
 *
 * @returns {Array<{id,name,en,score,def,image,variantOf}>}
 */
export function rankStylesByVector(dir, lang, vec, opts = {}){
  const k = opts.styles || 5;
  const { meta, buf, mask, byId } = loadStyleVectors(dir, lang);
  const dims = meta.dims;
  const n = meta.n;
  const best = new Map();

  for (let i = 0; i < n; i++){
    let top = -2;
    for (let r = 0; r < 2; r++){
      if (r === 1 && !(mask[i >> 3] & (1 << (i & 7)))) continue;
      const off = (r * n + i) * dims;
      let d = 0;
      for (let j = 0; j < dims; j++) d += vec[j] * buf[off + j];
      if (d > top) top = d;
    }
    const score = top / 127;
    const id = meta.ids[i];
    const st = byId[id] || { id, name: id };
    const key = groupKey(st);
    const prev = best.get(key);
    /* 同组取分高的；完全打平时留基风格（variant 为空的） */
    if (!prev || score > prev.score || (score === prev.score && !st.variant && prev.variantOf)){
      best.set(key, { id, name: st.name, en: st.en || null, score: +score.toFixed(4),
        def: st.def || null, terms: st.terms || null, images: st.images || null, variantOf: st.parent || null });
    }
  }
  return Array.from(best.values()).sort((a, b) => b.score - a.score).slice(0, k);
}
