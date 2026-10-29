/* 自动生成，请勿直接编辑。源文件：api/words.mjs（node deploy/pack-mcp.mjs 同步） */
/**
 * words.mjs —— v2 解析器（两层结构：词 → 风格）
 *
 * 纯词典路径：同步、零 IO、无第三方依赖、不加载神经网络。
 * 与前端同一条口径：词面命中（词本身 + 别名表）→ 词加权 → 风格按「命中词数 / √词数」排序。
 *
 * 数据来源：src/words.json · standards/latest.json（styles / word_index / share）
 *           standards/aliases.json
 *
 * 与 v1 的差别：没有 feelings[]（感受层已撤除），排序对象从作品换成风格。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './paths.mjs';

const ROOT = DATA_ROOT;
let cache = null;

function readJSON(rel){
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

export function loadWords(){
  if (cache) return cache;
  const words  = readJSON('src/words.json');
  const latest = readJSON('standards/latest.json');
  let aliases = {};
  try { aliases = readJSON('standards/aliases.json').aliases || {}; } catch (err){}
  const byId = Object.fromEntries(latest.styles.map(s => [s.id, s]));
  const wordList = Array.isArray(words) ? words : (words.words || []);
  cache = {
    words,
    wordList,
    byWord: Object.fromEntries(wordList.map(w => [w.w, w])),
    wordSet: new Set(wordList.map(w => w.w)),
    index: latest.word_index || {},
    share: latest.share || {},
    styles: latest.styles || [],
    styleById: byId,
    byStyle: byId,
    aliases,
    styleByName: (() => {
      const m = {};
      (latest.styles || []).forEach(x => { m[x.name] = x.id; if (x.en) m[String(x.en).toLowerCase()] = x.id; });
      return m;
    })(),
    links: latest.word_links || [],
    opposites: latest.opposites || [],
    version: latest.version || null,
  };
  return cache;
}

const isCJK = s => /[\u3400-\u9FFF]/.test(s);

/** 否定跨度：从否定词之后，到句读为止 */
function negSpans(text){
  const out = [];
  const re = /(不要|不想要|别|避免|不是|没有|去掉|少一点|远离)/g;
  let m;
  while ((m = re.exec(text))){
    const from = m.index + m[0].length;
    const seg = text.slice(from, from + 24).split(/[，,。；;！？]/)[0];
    out.push([from, from + seg.length]);
  }
  return out;
}
const inSpans = (spans, i) => spans.some(([a, b]) => i >= a && i < b);

/** 词面：词本身 + 别名，带位置。返回 词 → 分数（0–1） */
export function scoreWords(text, spans){
  const D = loadWords();
  const q = String(text || '').toLowerCase();
  const sp = spans || [];
  const out = {};
  const bump = (w, v) => { if (!D.wordSet.has(w)) return; out[w] = Math.max(out[w] || 0, v); };
  const scan = (needle, v) => {
    if (!needle) return;
    let i = q.indexOf(needle);
    while (i >= 0){
      if (!inSpans(sp, i)) return bump(needle, v), undefined;
      i = q.indexOf(needle, i + 1);
    }
  };
  for (const w of D.wordSet) scan(w, 1);
  /* 前缀兜底：打字过程中要有词（与前端同口径）。
     「压」还没成词，但用户要的是「压抑」，这一条负责把流式体验接上。 */
  if (!sp.length && q.length <= 8 && !Object.keys(out).length){
    const tail = q.slice(-3);
    for (const w of D.wordSet){
      if (w.length < 2) continue;
      for (let L = Math.min(3, w.length - 1); L >= (q.length === 1 ? 1 : 2); L--){
        if (tail.endsWith(w.slice(0, L))) { bump(w, (0.26 + L * 0.07) * (COARSE.has(w) ? 1.5 : 1)); break; }
      }
    }
  }
  for (const [a, list] of Object.entries(D.aliases)){
    if (a.length < 2) continue;
    let i = q.indexOf(a);
    while (i >= 0){
      if (!inSpans(sp, i)) list.forEach(w => bump(w, 0.8));
      i = q.indexOf(a, i + 1);
    }
  }
  return out;
}

const NG_WEAK = /(不那么|不要太|稍微不|有点不)/;
/** 强否定：跨度内的命中直接排除；弱否定：跨度内的命中降权 */
function negation(text){
  const spans = negSpans(text);
  const all = Object.keys(scoreWords(text));
  const outside = new Set(Object.keys(scoreWords(text, spans)));
  const exclude = all.filter(w => !outside.has(w));
  const weak = {};
  const wm = NG_WEAK.exec(text);
  if (wm){
    const from = wm.index + wm[0].length;
    const seg = text.slice(from, from + 24).split(/[，,。；;！？]/)[0];
    Object.keys(scoreWords(seg)).forEach(w => { weak[w] = 0.4; });
  }
  return { exclude, weak };
}

/** 主入口：一句话 → { words, styles } */
const COARSE = new Set(['宁静','温暖','怀旧','欢快','激昂','崇高','忧郁','疏离','压抑','焦虑','狂躁','怪诞','梦幻','秩序','市井','神圣','恐怖','情色','幽默','悲剧','厌恶','孤独','天真','虚无','神秘','眩晕','权力']);

/* 一个风格的「主图」：优先 work（有出处可引用），其次是 synthetic / placeholder。
   地址是相对路径（/media/works/...），HTTP 层按请求 origin 拼成绝对地址。 */
const IMAGE_FIELDS = ['thumb', 'full', 'w', 'h', 'palette', 'kind', 'credit', 'license', 'source', 'source_url'];

export function primaryImage(style){
  const list = (style && style.images) || [];
  if (!list.length) return null;
  const pick = list.find(im => im.role === 'primary')
    || list.find(im => im.kind === 'work')
    || list[0];
  if (!pick || !pick.thumb) return null;
  const out = { ref: pick.ref };
  for (const k of IMAGE_FIELDS) if (pick[k] !== undefined) out[k] = pick[k];
  return out;
}

export function styleDetail(id){
  const D = loadWords();
  const s = D.byStyle[id];
  if (!s) return null;
  const images = (s.images || []).map(im => {
    const out = { ref: im.ref };
    for (const k of IMAGE_FIELDS) if (im[k] !== undefined) out[k] = im[k];
    return out;
  });
  return {
    id: s.id, name: s.name, en: s.en || null, name_status: s.name_status || null,
    def: s.def || null, defGen: s.defGen || null,
    terms: s.terms || [], origins: s.origins || null, parent: s.parent || null,
    variant: s.variant || null, chain: s.chain || [], conf: s.conf || null,
    images,
  };
}

export function analyzeWords(text, opts = {}){
  const t0 = process.hrtime.bigint();
  const D = loadWords();
  const raw = String(text || '').trim();
  const lang = isCJK(raw) ? 'zh' : 'en';
  const wordN = Math.max(1, Math.min(12, opts.words || 8));
  const styleN = Math.max(1, Math.min(30, opts.styles || 12));

  const sc = scoreWords(raw);
  const ng = negation(raw);
  ng.exclude.forEach(w => { delete sc[w]; });
  Object.keys(ng.weak).forEach(w => { if (sc[w]) sc[w] *= ng.weak[w]; });

  const rankedWords = Object.keys(sc)
    .map(w => ({ w, s: sc[w] }))
    .sort((a, b) => b.s - a.s || a.w.localeCompare(b.w));
  const max = rankedWords.length ? rankedWords[0].s : 1;
  const words = rankedWords.slice(0, wordN).map(r => ({
    w: r.w,
    score: +(r.s / max).toFixed(3),
    share: D.share[r.w] || 0,                      // 被几个风格使用：区分标识词/泛词
    styles: (D.index[r.w] || []).slice(0, 6),      // 这个词落到哪些风格
  }));

  /* 风格名直命：用户直接说出风格名时不绕词表 */
  const direct = [];
  {
    const low = raw.toLowerCase();
    const keys = Object.keys(D.styleByName).sort((a, b) => b.length - a.length);
    for (const k of keys){
      if (k.length >= 2 && low.includes(k)){
        const id = D.styleByName[k];
        if (id && direct.indexOf(id) < 0) direct.push(id);
      }
    }
  }
  const qmap = {};
  words.forEach(w => { qmap[w.w] = w.score; });
  const qnorm = Math.sqrt(words.reduce((s, w) => s + w.score * w.score, 0)) || 1;

  const styles = D.styles.map(s => {
    let hit = 0, hits = 0;
    const matched = [];
    for (const t of s.terms || []){
      const q = qmap[t];
      if (q === undefined) continue;
      hit += q * q * (COARSE.has(t) ? 2.2 : 1); hits++; matched.push(t);
    }
    const directHit = direct.includes(s.id);
    return {
      id: s.id, name: s.name, en: s.en || null,
      score: +((hit / Math.sqrt(Math.max(1, (s.terms || []).length)) / qnorm) + (directHit ? 1.5 : 0)).toFixed(4),
      hits, matched,
      def: s.def || null,
      parent: s.parent || null,
      /* 图不在这里给：取图是单独一次（计费）请求，见 /v2/images 与 /v2/styles/:id */
    };
  }).filter(s => s.hits > 0 || direct.includes(s.id))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, styleN);

  const latency = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    ok: true,
    input: { text: raw, lang, chars: [...raw].length },
    words,
    styles,
    excluded: ng.exclude,
    direct: direct,
    meta: {
      version: D.version,
      engine: 'lexicon',
      matched_words: rankedWords.length,
      latency_ms: Math.round(latency * 100) / 100,
    },
  };
}

/** 枚举：词与风格（供调用方做参数校验 / 建索引） */
/* ---------- 词 ↔ 风格 的免费关联查询 ---------- */

/* 一个感受词 → 它落在哪些风格上（按「该风格命中几个词」简单排序用不上，这里保留数据顺序，
   并把词的元信息一起给出，方便调用方一次拿全） */
export function wordDetail(word){
  const D = loadWords();
  const w = String(word || '').trim();
  if (!w) return null;
  const rec = D.byWord[w];
  const styleIds = D.index[w] || (rec && rec.styles) || [];
  if (!rec && !styleIds.length) return null;
  const styles = styleIds.map((id) => {
    const s = D.styleById[id];
    return { id, name: s ? s.name : null, en: (s && s.en) || null, def: (s && s.def) || null };
  });
  const near = (D.links || [])
    .filter(e => e.a === w || e.b === w)
    .sort((x, y) => (y.pmi || 0) - (x.pmi || 0))
    .slice(0, 10)
    .map(e => (e.a === w ? e.b : e.a));
  const opp = (rec && rec.opposite) || (D.opposites || [])
    .filter(e => e.a === w || e.b === w)
    .map(e => (e.a === w ? e.b : e.a));
  return {
    word: w,
    share: D.share[w] != null ? D.share[w] : styleIds.length,
    marker: (D.share[w] != null ? D.share[w] : styleIds.length) <= 6,
    gloss: (rec && rec.gloss) || null,
    explain: (rec && rec.explain) || null,
    english: rec && Array.isArray(rec.en) && rec.en[0] ? rec.en[0].w : null,
    styles,
    opposite: Array.from(new Set(opp)),
    co_occurs: near,
  };
}

/* 一个风格 → 它的感受词。按 share 升序（标识词在前：被更少风格共用 = 更能区分这个风格） */
export function styleWords(id){
  const D = loadWords();
  const s = D.styleById[String(id || '').trim()];
  if (!s) return null;
  const terms = (s.terms || []).map((w) => ({
    w,
    share: D.share[w] != null ? D.share[w] : (D.index[w] || []).length,
    marker: (D.share[w] != null ? D.share[w] : (D.index[w] || []).length) <= 6,
  }));
  terms.sort((a, b) => a.share - b.share || a.w.localeCompare(b.w));
  return {
    style: { id: s.id, name: s.name, en: s.en || null, def: s.def || null },
    count: terms.length,
    words: terms,
  };
}

/* 按 id 批量取图（/v2/images 用）。返回 {images:[{id,name,image|null}], missing:[id]} */
export function imagesById(ids){
  const D = loadWords();
  const images = [];
  const missing = [];
  for (const raw of ids) {
    const id = String(raw || '').trim();
    if (!id) continue;
    const s = D.byStyle[id];
    if (!s) { missing.push(id); continue; }
    const image = primaryImage(s);
    if (!image) { missing.push(id); continue; }
    images.push({ id: s.id, name: s.name, image });
  }
  return { images, missing };
}

export function dictionaryWords(){
  const D = loadWords();
  return {
    words: D.words.map(w => ({
      w: w.w, pos: w.pos || null,
      gloss: w.gloss || '', explain: w.explain || '',
      opposite: w.opposite || [], share: D.share[w.w] || 0,
      styles: D.index[w.w] || [],
    })),
    styles: D.styles.map(s => ({
      id: s.id, name: s.name, en: s.en || null,
      def: s.def || null, parent: s.parent || null,
      terms: s.terms || [],
    })),
    counts: { words: D.words.length, styles: D.styles.length },
    /* 数据版本：以前只有错误响应带 meta.version，成功响应里查不到，
       调用方想判断「词表是不是换了」只能去拉 standards/version.json。 */
    version: D.version || null,
  };
}
