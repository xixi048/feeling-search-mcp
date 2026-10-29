/* 自动生成，请勿直接编辑。源文件：api/semantic.mjs（node deploy/pack-mcp.mjs 同步） */
/**
 * semantic.mjs —— 语义引擎层（中文 zh-engine / 英文 ternlight）+ 与词典层的融合
 *
 * 为什么放这里而不是 mcp/：`/v2/analyze` 和 `/mcp` 要用同一套融合逻辑，
 * 而这两条链路都已经 ts 因为语言歧义而漂移过一次了（mcp 那份手抄漏了否定和单字词）。
 * 所以引擎、融合、缓存全部只在这里写一份，两个入口都调它。
 *
 * 数据从哪来：`DATA_ROOT` 下有没有 `standards/zh-engine/weights.bin` 决定引擎是否可用。
 *   · 云端：文件由 edgeone.json 的 cloudFunctions.includeFiles 打进 bundle（/var/user/included_files）
 *   · 本地包：pack-mcp.mjs 铺到 <pkg>/data
 *   · 都没有：直接返回词典结果，行为与以前一致
 *
 * 性能（真机实测）：权重 fs 冷读 2.6ms、引擎 load 154ms、单次 parse 4–7ms。
 * 云端每个请求都是冷启动（实例不复用），所以引擎只在**词典零命中/仅命中一个词**时才加载。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_ROOT } from './paths.mjs';
import { analyzeWords, loadWords, primaryImage } from './analyze.mjs';

const CACHE = new Map();
const json = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const read = (p) => new Uint8Array(fs.readFileSync(p));

/* ------------------------------ 是否有引擎 ------------------------------ */

let AVAIL = null;

/** 引擎在不在：只认文件，不认环境变量（云端设不了环境变量） */
export function engineAvailable(){
  if (AVAIL !== null) return AVAIL;
  try {
    AVAIL = fs.existsSync(path.join(DATA_ROOT, 'standards', 'zh-engine', 'weights.bin'));
  } catch { AVAIL = false; }
  return AVAIL;
}

export function engineInfo(){
  return {
    available: engineAvailable(),
    root: DATA_ROOT,
    zh: engineAvailable(),
    en: (() => { try { return fs.existsSync(path.join(DATA_ROOT, 'standards', 'ternlight', 'engine.wasm')); } catch { return false; } })(),
  };
}

/* ------------------------------ 语言判定 ------------------------------ */

/** 有汉字就是中文。纯英文/数字/符号走英文引擎。 */
export function detectLang(text){
  return /[\u4e00-\u9fff]/.test(String(text || '')) ? 'zh' : 'en';
}

export function engineName(lang){
  return lang === 'zh' ? 'zh-engine' : 'en-engine';
}

/* ------------------------------ 引擎加载 ------------------------------ */

async function loadZh(){
  const base = path.join(DATA_ROOT, 'standards', 'zh-engine');
  const mod = await import(pathToFileURL(path.join(base, 'engine-zh.mjs')).href);
  /* 第二个参数是 reader：给了就不走 fetch，直接从磁盘读 */
  const eng = await mod.ZhEngine.load('/standards/zh-engine/', async (f) => read(path.join(base, f)));
  return {
    lang: 'zh',
    wasm: !!eng.wasm,
    embed: (text) => Float32Array.from(eng.embedText(text)),
    /* 27 组粗锚点：引擎包已解码，直接给中文名与余弦 */
    anchors: (text, k = 4) => (eng.score(text) || []).slice(0, k)
      .map((a) => ({ w: a.name, id: a.id, score: +(a.c ?? a.cos ?? 0).toFixed(3) })),
  };
}

async function loadEn(){
  const base = path.join(DATA_ROOT, 'standards', 'ternlight');
  const mod = await import(pathToFileURL(path.join(base, 'engine.js')).href);
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
    /* 英文侧没有内置锚点表（词走词典层），只给风格向量 */
    anchors: () => [],
  };
}

function loadEngine(lang){
  const key = DATA_ROOT + '|' + lang;
  if (!CACHE.has(key)){
    CACHE.set(key, (lang === 'zh' ? loadZh() : loadEn()).catch((e) => {
      CACHE.delete(key);
      throw e;
    }));
  }
  return CACHE.get(key);
}

/* ------------------------------ 风格向量 ------------------------------ */

/** 598 个风格 × 2 路（定义 / 生成提示词）的 int8 向量；q8 已 L2 归一，除 127 即余弦 */
function loadStyleVectors(lang){
  const key = DATA_ROOT + '|vec|' + lang;
  if (CACHE.has(key)) return CACHE.get(key);
  const core = json(path.join(DATA_ROOT, 'standards', 'sem-core.json'));
  const meta = lang === 'zh' ? core.assets.stylesZh : core.assets.stylesEn;
  if (!meta) throw new Error('sem-core.json 里没有 ' + lang + ' 的风格向量');
  const buf = new Int8Array(fs.readFileSync(path.join(DATA_ROOT, meta.path)).buffer.slice(0));
  const mask = Buffer.from(meta.mask, 'base64');
  const latest = json(path.join(DATA_ROOT, 'standards', 'latest.json'));
  const byId = Object.fromEntries(latest.styles.map((s) => [s.id, s]));
  const out = { meta, buf, mask, byId };
  CACHE.set(key, out);
  return out;
}

/** 变体去重：冻雨霓虹是霓虹雨街的变体，分数一样，只留基风格 */
const groupKey = (s) => (s && s.parent) || (s && s.id) || '';

/** 查询向量 → 风格排名（与网页同一条打分：向量 vs 598 个风格向量取余弦） */
export function rankStylesByVector(lang, vec, k = 5){
  const { meta, buf, mask, byId } = loadStyleVectors(lang);
  const dims = meta.dims, n = meta.n;
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
    if (!prev || score > prev.score || (score === prev.score && !st.variant && prev.variantOf)){
      best.set(key, {
        id, name: st.name, en: st.en || null, score: +score.toFixed(4),
        hits: 0, matched: [], def: st.def || null, parent: st.parent || null,
        terms: st.terms || null, image: primaryImage(st),
        variantOf: st.parent || null,
      });
    }
  }
  return Array.from(best.values()).sort((a, b) => b.score - a.score).slice(0, k);
}

/* ------------------------------ 主入口 ------------------------------ */

/**
 * 一句话 → 词 + 风格。先词典，看不懂（命中 <2 个词）才上引擎。
 *
 * @param {string} text
 * @param {{words?:number, styles?:number, lang?:'auto'|'zh'|'en'}} opts
 */
export async function analyzeWithEngine(text, opts = {}){
  const raw = String(text || '');
  const lang0 = opts.lang && opts.lang !== 'auto' ? opts.lang : detectLang(raw);
  const base = analyzeWords(raw, { words: opts.words, styles: opts.styles });

  /* ① 词表命中 ≥2 个词：算看懂了，引擎一个字节都不碰 */
  if (base.words.length >= 2 || !engineAvailable()){
    return { ...base, source: 'local', engine: 'lexicon', lang: lang0 };
  }

  /* ② 零命中或只命中一个词：上引擎 */
  try {
    const lang = lang0;
    const eng = await loadEngine(lang);
    const vec = eng.embed(raw);
    const styles = rankStylesByVector(lang, vec, opts.styles || 5);
    if (!styles.length) return { ...base, source: 'local', engine: 'lexicon', lang };

    /* 否定在引擎外面算：嵌入表达不了否定，用词典层已经算好的 excluded 剪 */
    const excluded = new Set(base.excluded || []);
    const kept = excluded.size
      ? styles.filter((st) => !(st.terms || []).some((t) => excluded.has(t)))
      : styles;
    if (!kept.length){
      return { ...base, source: 'local', engine: 'lexicon', lang,
        engine_note: '整句被否定词剪空，回退词典结果' };
    }

    /* 弱否定也要作用到锚点上：词典层把「不太压抑」压到 0.4，引擎不能又给回满分 */
    const weak = new Set(base.weakened || []);
    const anchors = (eng.anchors(raw, opts.words || 4) || [])
      .filter((w) => !excluded.has(w.w))
      .map((w) => (weak.has(w.w) ? { ...w, score: +(w.score * 0.4).toFixed(3), weakened: true } : w));
    const seen = new Set(anchors.map((w) => w.w));
    const words = anchors.concat(
      base.words.filter((w) => !seen.has(w.w)).map((w) => ({ ...w, from: 'lexicon' })),
    );

    return {
      ...base,
      words,
      styles: kept,
      excluded: base.excluded,
      source: 'engine',
      engine: engineName(lang),
      lang,
      meta: {
        version: base.meta && base.meta.version,
        engine: 'embed',
        lang,
        matched_words: base.meta ? base.meta.matched_words : 0,
        note: lang === 'zh'
          ? '词表零命中或只命中一个词，这一条来自中文语义引擎（词是 27 组粗锚点，风格由查询向量与 598 个风格向量求余弦）'
          : '词表零命中或只命中一个词，这一条来自英文语义引擎（英文请整句用英文；含汉字会判成中文）',
      },
    };
  } catch (e){
    /* 引擎挂了不能把请求打挂：降级回词典，并如实说明 */
    return { ...base, source: 'local', engine: 'lexicon', lang: lang0,
      engine_note: '引擎加载失败，已降级词典：' + (e && e.message ? e.message : String(e)) };
  }
}
