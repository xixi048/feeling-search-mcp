/* 自动生成，请勿直接编辑。源文件：mcp/tools.mjs（node deploy/pack-mcp.mjs 同步） */
/**
 * mcp/tools.mjs — 工具定义（v0.3 两层结构：词 → 风格）
 *
 * 零依赖：只吃 Node 内置模块与本仓库代码（远端要跑在云函数上，打包器是否带
 * node_modules 没有保证）。入参校验手写，默认值在 normalize() 统一兜。
 *
 * 与 v0.2 的差别：没有 feelings[]。查询落在「词」上，再把词落到「风格」上。
 */

import fs from 'node:fs';
import { dataPath } from './paths.mjs';
import { analyzeWords, loadWords, primaryImage } from './analyze.mjs';
import { detectLang, engineName, loadEngine, rankStylesByVector } from './engine.mjs';

export const SERVER_INFO = { name: 'feeling-search', version: '0.3.0' };
export const PROTOCOL_VERSION = '2025-06-18';

export const INSTRUCTIONS = `感觉检索：把一句口语描述换成准确的感受词，再落到具体的视觉风格。

工具选择：
- 要把一句话算成词与风格 → word_analyze（本地词典，免费、不联网）
- 查一个词落在哪些风格、它的对立词是什么 → word_lookup
- 要看全部词 / 风格的 id 与定义 → word_list
- 要拿某个风格的详情与**它对应的图** → style_get（图带 thumb/full 绝对地址）
- 想知道词表版本与规模 → word_status

两个语义引擎（装上本地包后生效，返回里的 source / engine 字段说明这条走了哪一层）：
- 中文引擎：整句中文 → 27 组粗锚点 + 598 个风格向量余弦。中文问句请整句用中文；
  别写成「有点 lonely 的雨夜」这种混写 —— 只要含汉字就判成中文，英文半句会被中文分词切碎。
- 英文引擎：整句英文 → 直接和风格向量比余弦。英文问句请整句用英文，别夹中文词。
- 要强制指定就传 lang: "zh" 或 "en"；默认 "auto"（含汉字判中文，否则判英文）。
- source 三个取值：local = 词表命中（最快，逐字匹配）；engine = 语义引擎（整句理解）；
  cloud = 云端兜底（远端才有）。engine 那层的 words 是 27 组粗锚点，不是细词；
  细词只出现在 local 那层。

重要：
- score 是“命中权重 / 词集规模”归一后的相对值，不是概率，跨查询不可比。
- words[].share 表示这个词被几个风格使用：≤6 是标识词（锋利、可用来区分风格），
  数值大是泛词（如「留白」「几何」）。挑风格时优先看 matched 里的标识词。
- styles[].matched 是命中的词，可以直接引用给用户看，比 score 更有说服力。
- styles[].image.kind 说明图的性质：work=有出处的真作品（CC0）、synthetic=AI 生成示意、
  placeholder=样张还没做完的占位图。**不要把 placeholder 当风格样本引用**。
- 不要抓 xiximm.cloud 的交互页，那是给人用的单页应用。
- **云端兜底要钱**：POST /v2/analyze 每次 $0.10（x402 / USDC 或 支付宝 AI 付）。
  环境变量 FS_QUOTA 没配时不要 pretend 成功，如实说「本地没命中，云端需要付费额度」。
- **怎么付**：allow_cloud 为 true 且本地零命中时，cloud_skipped.payment 里直接给机器可读的收款要求
  （x402 的 accepts 数组：链、金额、资产、收款地址；以及支付宝档位）。把同一段文字 POST 到
  payment.endpoint 完成支付，再把响应头里的 X-FS-Quota 作为 FS_QUOTA 配好后重试即可。
- 想知道价格与收款方式 → word_status（会返回 discovery 地址 /.well-known/x402）。`;

const API_URL = process.env.FS_API_URL || 'https://xiximm.cloud/v2/analyze';
const QUOTA = (process.env.FS_QUOTA || '').trim();
/* 图上给的是 /media/works/... 相对路径，MCP 客户端要能直接渲染，这里补成绝对地址 */
const ASSET_BASE = (process.env.FS_ASSET_BASE || 'https://xiximm.cloud').replace(/\/$/, '');

function withAssetBase(im){
  if (!im || typeof im !== 'object') return im;
  const fix = (u) => (typeof u === 'string' && u.startsWith('/') ? ASSET_BASE + u : u ?? null);
  return { ...im, thumb: fix(im.thumb), full: fix(im.full) };
}

/* 风格对象里只留调用方用得上的图字段，避免把 manifest 细节全抖出去 */
function styleImage(style){
  const list = (style && style.images) || [];
  if (!list.length) return null;
  const pick = list.find(im => im.role === 'primary') || list.find(im => im.kind === 'work') || list[0];
  if (!pick || !pick.thumb) return null;
  const { ref, thumb, full, w, h, kind, credit, license, source, source_url } = pick;
  return withAssetBase({ ref, thumb, full, w, h, kind, credit, license, source, source_url });
}

/* ------------------------------ 数据 ------------------------------ */

let CACHE = null;
function data(){
  if (CACHE) return CACHE;
  const rd = (rel, dflt) => { try { return JSON.parse(fs.readFileSync(dataPath(rel), 'utf8')); } catch { return dflt; } };
  const latest = rd('standards/latest.json', {});
  CACHE = {
    version: latest.version || null,
    counts: latest.counts || {},
    styles: latest.styles || [],
    index: latest.word_index || {},
    share: latest.share || {},
    links: latest.word_links || [],
    opposites: latest.opposites || [],
    words: rd('standards/words.json', { words: [] }).words || [],
    aliases: rd('standards/aliases.json', { aliases: {} }).aliases || {},
  };
  CACHE.wordSet = new Set(CACHE.words.map(w => w.w));
  CACHE.byWord = Object.fromEntries(CACHE.words.map(w => [w.w, w]));
  CACHE.byStyle = Object.fromEntries(CACHE.styles.map(s => [s.id, s]));
  return CACHE;
}

/* ------------------------------ 本地解析 ------------------------------ */

/**
 * 本地解析直接调 api/words.mjs 的 analyzeWords —— 不再自己写一份。
 *
 * 历史教训（2026-11-01 实测）：这里曾经有一份手抄的 scoreWords，抄漏了两处，
 * 线上表现是「不要压抑」返回压抑 1.0（应当返回空），「雨里旧香港那种潮湿的夜」
 * 连单字词「夜」都匹配不上。两份实现必然漂移，所以只保留 API 那一份。
 *
 * MCP 侧只多做两件事：图片补绝对地址（客户端要能直接渲染）、词补 explain。
 */
function analyzeLocal(text, opts = {}){
  const r = analyzeWords(text, { words: opts.words ?? 6, styles: opts.styles ?? 5 });
  const D = loadWords();
  const words = (r.words || []).map(w => ({ ...w, explain: (D.byWord[w.w] || {}).explain || '' }));
  const styles = (r.styles || []).map(s => ({
    id: s.id, name: s.name, en: s.en || null, score: s.score, hits: s.hits, matched: s.matched,
    def: s.def || null, parent: s.parent || null,
    image: withAssetBase(primaryImage(D.styleById[s.id])),
  }));
  return { ...r, words, styles, source: 'local' };
}

/* ------------------------------ 云端兜底 ------------------------------ */

async function callCloud(text, opts){
  /* 额度令牌优先用调用方按次传的（远端 MCP 客户端设不了环境变量），其次才是 FS_QUOTA */
  const token = String(opts.quota || QUOTA || '').trim();
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-FS-Quota': token } : {}) },
      body: JSON.stringify({ text, words: opts.words ?? 6, styles: opts.styles ?? 5 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.ok ? { ...j, source: 'cloud' } : null;
  } catch { return null; }
}

/* ------------------------------ 四个工具 ------------------------------ */

async function analyzeHandler(a){
  const text0 = String(a.text || '');
  const local = analyzeLocal(a.text, a);
  local.lang = detectLang(text0);
  local.engine = 'lexicon';
  /* ① 词表命中 2 个以上词：算「看懂了」，直接给结果，引擎一个字节都不碰。
     只命中 0~1 个词说明词典没真正读懂这句（典型是整句口语，只蹭到一个泛字），
     这种情况交给语义引擎 —— 单字命中（如「夜」）也不该挡住整句理解。 */
  if (local.words.length >= 2) return local;

  /* ② 词表零命中：本地装了引擎就上引擎（免费、离线、不联网） */
  const dir = String(process.env.FS_ENGINE_DIR || '').trim();
  if (dir){
    try {
      const lang = a.lang && a.lang !== 'auto' ? a.lang : detectLang(a.text);
      const eng = await loadEngine(dir, lang);
      const vec = eng.embed(a.text);
      const styles = rankStylesByVector(dir, lang, vec, { styles: a.styles ?? 5 }).map((s) => ({
        id: s.id, name: s.name, en: s.en, score: s.score, hits: 0, matched: [],
        def: s.def, parent: s.variantOf, image: withAssetBase(primaryImage(s)),
      }));
      /* 否定在引擎外面算：嵌入天生表达不了「不要压抑」，必须用确定性逻辑剪掉。
         local.excluded 是词典层已经算好的强否定词（cue → 跨度 → 词），直接复用。 */
      const excluded = new Set(local.excluded || []);
      const words0 = (eng.anchors(a.text, a.words ?? 4) || [])
        .filter((w) => !excluded.has(w.w))
        .map((w) => (excluded.size ? { ...w, negated_out: [...excluded] } : w));
      /* 词表那 1 个词别丢，放到引擎词后面，标明来源；同名去重，引擎分优先 */
      const seen = new Set(words0.map((w) => w.w));
      const words = local.words.length
        ? [...words0, ...local.words.filter((w) => !seen.has(w.w)).map((w) => ({ ...w, from: 'lexicon' }))]
        : words0;
      /* 被否定的词还要从风格侧剪掉：风格带该词就整个降级掉 */
      const kept = excluded.size
        ? styles.filter((st) => !(st.terms || []).some((t) => excluded.has(t)))
        : styles;
      /* 引擎一条风格都没给出（极短、纯符号、或被否定剪空）就当没跑过，回退词典结果 */
      if (!kept.length) return { ...local, engine_note: excluded.size ? '整句被否定词剪空，回退词典结果' : undefined };
      const ranked = kept.map((s, i) => ({ ...s, score: +(s.score * (i === 0 && excluded.size ? 0.999 : 1)).toFixed(4) }));
      return {
        ...local,
        words,
        styles: ranked,
        source: 'engine',
        engine: engineName(lang),
        lang,
        meta: {
          version: local.meta?.version,
          engine: 'embed',
          lang,
          matched_words: words.length,
          note: lang === 'zh'
            ? '词表零命中，这一条来自中文语义引擎（词为 27 组粗锚点，风格由查询向量与 598 个风格向量求余弦得到）'
            : '词表零命中，这一条来自英文语义引擎（英文查询请整句用英文；中英混写按是否含汉字判语言）',
        },
      };
    } catch (e){
      /* 引擎挂了不能把请求打挂：降级回词典，并如实说明 */
      return { ...local, source: 'local', engine_note: '引擎加载失败，已降级词典：' + (e && e.message ? e.message : String(e)) };
    }
  }

  /* ③ 没有引擎：走原来的云端兜底（远端 /mcp 与自建部署的行为不变） */
  const cloud = await callCloud(a.text, a);
  if (cloud) return cloud;
  /* 本地零命中且云端拿不到结果：说清是为什么，而不是装作“本地就这个结果”。
     付费要求本身也要机器可读 —— 远端 HTTP 层会再往里补 x402 的 accepts（见 mcp/http.mjs），
     tools 这一层保持零依赖，所以只给端点、档位和重试方式。 */
  return {
    ...local,
    cloud_skipped: {
      reason: (String(a.quota || '').trim() || QUOTA) ? 'cloud_unavailable' : 'payment_required',
      /* 兼容旧的字符串口径，新调用方读 price_detail */
      price: '$0.10 / 次',
      price_detail: { usd: 0.10, cny: 0.10, unit: 'per analysis', note: 'one analysis = one cloud fallback call' },
      rails: ['x402', 'alipay'],
      rails_label: ['x402 (USDC: Base / Solana)', 'alipay (CNY)'],
      /* 只有 x402 是给程序的；支付宝那条需要真人在支付宝里确认，agent 不要试 */
      agent_rails: ['x402'],
      quota: { header: 'X-FS-Quota', env: 'FS_QUOTA' },
      payment: {
        endpoint: API_URL,
        method: 'POST',
        body: { text: a.text },
        discovery: ASSET_BASE + '/.well-known/x402',
        alipay: {
          amount: '0.10',
          currency: 'CNY',
          resource_id: 'analyze_quota_1',
          requires_human: true,
          note: 'Alipay has no machine-signable credential: the payer must confirm in the Alipay app. POST payment.endpoint to get the amtPaymentLink header, then hand it to a human. Agents should use x402 instead.',
          claim: ASSET_BASE + '/v2/quota/claim',
          status: ASSET_BASE + '/v2/orders',
        },
      },
      retry: {
        step: 'pay via x402, read the X-FS-Quota response header, then pass it as the quota argument (or FS_QUOTA) and call this tool again',
      },
      how: {
        en: 'Local lexicon had no match, so the cloud fallback is needed and it is paid. Only x402 is automatic: POST the same text to payment.endpoint and pay $0.10 in USDC on Base or Solana (see payment.accepts), then pass the returned X-FS-Quota value as the quota argument and call word_analyze again. The Alipay rail (¥0.10) needs a human to confirm in the Alipay app — do not attempt it as an agent.',
        zh: '本地词典没命中，云端兜底是付费的。只有 x402 能自动化：把同一段文字 POST 到 payment.endpoint，用 USDC（Base 或 Solana，见 payment.accepts）付 $0.10，再把响应头里的 X-FS-Quota 作为 quota 参数重调 word_analyze。支付宝那条（0.10 元）必须真人在支付宝 App 里确认，agent 不要尝试。',
      },
    },
  };
}

async function lookupHandler(a){
  const D = data();
  const w = a.word.trim();
  const rec = D.byWord[w];
  if (!rec) return { ok: false, error: 'not_found', message: `词表里没有「${w}」`, suggestions: Object.keys(D.byWord).filter(x => x.includes(w) || w.includes(x)).slice(0, 8) };
  const near = D.links.filter(e => e.a === w || e.b === w).sort((x, y) => y.pmi - x.pmi).slice(0, 10)
    .map(e => (e.a === w ? e.b : e.a));
  return {
    ok: true,
    word: w,
    gloss: rec.gloss, explain: rec.explain,
    share: D.share[w] || 0,
    marker: (D.share[w] || 0) <= 6,
    styles: (D.index[w] || []).map(id => ({ id, name: (D.byStyle[id] || {}).name || id })),
    opposite: rec.opposite || [],
    co_occurs: near,
    english: rec.en && rec.en[0] ? rec.en[0].w : null,
  };
}

async function listHandler(a){
  const D = data();
  if (a.kind === 'styles'){
    return { ok: true, count: D.styles.length, styles: D.styles.map(s => ({ id: s.id, name: s.name, en: s.en || null, terms: s.terms.length, parent: s.parent || null, def: s.def || null, image: styleImage(s) })) };
  }
  return { ok: true, count: D.words.length, words: D.words.map(w => ({ w: w.w, share: D.share[w.w] || 0, styles: (D.index[w.w] || []).length })) };
}

async function statusHandler(){
  const D = data();
  return {
    ok: true,
    version: D.version,
    counts: D.counts,
    cloud: {
      configured: Boolean(QUOTA),
      url: API_URL,
      price: '$0.10 / 次',
      price_cny: '0.10 元 / 次',
      rails: ['x402', 'alipay'],
      rails_label: ['x402 (USDC: Base / Solana)', 'alipay (CNY / 人民币)'],
      discovery: ASSET_BASE + '/.well-known/x402',
      quota: { header: 'X-FS-Quota', env: 'FS_QUOTA' },
      hint: QUOTA ? undefined : {
        en: 'FS_QUOTA is not set, so only the local (free) tier runs; cloud fallback needs a paid quota token from payment.endpoint.',
        zh: '未配 FS_QUOTA：本地命中不花钱，但云端兜底需要付费额度（见 payment.endpoint）。',
      },
    },
    note: '词是唯一索引；风格是唯一实体；对立词靠人写，共现靠风格反算。',
  };
}

async function styleHandler(a){
  const D = data();
  const want = String(a.id || '').trim().toLowerCase();
  const s = D.byStyle[want] || Object.values(D.byStyle).find(x => String(x.name) === a.id);
  if (!s) {
    return {
      ok: false, error: 'not_found', message: `没有风格「${a.id}」`,
      suggestions: Object.keys(D.byStyle).filter(x => x.includes(want)).slice(0, 8),
    };
  }
  const images = (s.images || []).map((im) => {
    const { ref, thumb, full, w, h, kind, credit, license, source, source_url } = im;
    return withAssetBase({ ref, thumb, full, w, h, kind, credit, license, source, source_url });
  });
  /* terms 与 API 的 /v2/styles/{id}/words 同形状：标识词在前，带 share/marker */
  const terms = (s.terms || []).map((w) => {
    const share = D.share[w] != null ? D.share[w] : (D.index[w] || []).length;
    return { w, share, marker: share <= 6 };
  }).sort((a, b) => a.share - b.share || a.w.localeCompare(b.w));

  return {
    ok: true,
    style: {
      id: s.id, name: s.name, en: s.en || null, name_status: s.name_status || null,
      def: s.def || null, defGen: s.defGen || null, terms,
      origins: s.origins || null, parent: s.parent || null, variant: s.variant || null,
      chain: s.chain || [], conf: s.conf || null, images,
    },
  };
}

export const TOOLS = [
  {
    name: 'word_analyze',
    title: '把一句描述解析成词与风格',
    description:
      '把一句中文/英文口语描述解析成感受词与视觉风格。默认纯本地词典（免费、不联网）；本地一个词都没命中且允许时，才上云。返回 score 是相对值不是概率，styles[].matched 是可以直接引用给用户看的命中词。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 500, description: '要解析的描述，最长 500 字' },
        words: { type: 'integer', minimum: 1, maximum: 12, default: 6, description: '返回几个感受词' },
        styles: { type: 'integer', minimum: 0, maximum: 20, default: 5, description: '返回几个视觉风格' },
        lang: { type: 'string', enum: ['auto', 'zh', 'en'], default: 'auto', description: '用哪个语义引擎：auto 按是否含汉字判定。中文问句请用中文整句，英文问句请用英文整句，中英混写会落到中文引擎' },
        allow_cloud: { type: 'boolean', default: true, description: '本地零命中且本机没装引擎时，是否允许上云' },
        quota: { type: 'string', maxLength: 256, description: '已购额度令牌（响应头 X-FS-Quota 的值）。本机也可用环境变量 FS_QUOTA；远端 MCP 客户端没法设环境变量，就用这个参数' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    defaults: { words: 6, styles: 5, lang: 'auto', allow_cloud: true },
    run: analyzeHandler,
  },
  {
    name: 'word_lookup',
    title: '查一个词落在哪些风格',
    description: '查一个感受词：落在哪些风格、对立词是什么、常一起出现的词、是否标识词。纯本地查表。',
    inputSchema: {
      type: 'object',
      properties: {
        word: { type: 'string', minLength: 1, maxLength: 30, description: '要查的词，如「留白」「枯淡」' },
      },
      required: ['word'],
      additionalProperties: false,
    },
    defaults: {},
    run: lookupHandler,
  },
  {
    name: 'word_list',
    title: '枚举感受词或视觉风格',
    description: '列出全部感受词（带共享度）或视觉风格（带定义与词集规模）。调 analyze 之前先拉一次可避免名字拼错。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['words', 'styles'], default: 'words', description: '枚举哪一类' },
      },
      additionalProperties: false,
    },
    defaults: { kind: 'words' },
    run: listHandler,
  },
  {
    name: 'style_get',
    title: '取单个风格的定义与对应图片',
    description:
      '按风格 id（或中文名）取一个风格：定义、生成用提示词、感受词、年代地域，以及它对应的图片（thumb 320 / full 960 绝对地址，带 kind/credit/license）。kind=work 是有出处的真作品，synthetic 是 AI 示意，placeholder 是占位图。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 64, description: '风格 id（如 synthwave）或中文名（如 合成器波）' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    defaults: {},
    run: styleHandler,
  },
  {
    name: 'word_status',
    title: '查看词表版本与云端额度状态',
    description: '返回词表版本、规模（词/风格/变种/挂靠率）以及是否配置了云端额度。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    defaults: {},
    run: statusHandler,
  },
];

export const TOOL_NAMES = TOOLS.map(t => t.name);

/** 补默认值 + 粗校验（SDK 那条路也会走到这里） */
export function normalize(name, args){
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) return { error: `未知工具 ${name}。可用：${TOOL_NAMES.join(', ')}` };
  const a = { ...tool.defaults, ...(args || {}) };
  const p = tool.inputSchema.properties || {};
  for (const [k, v] of Object.entries(p)){
    if (!(k in a)) continue;
    const val = a[k];
    if (v.type === 'integer' || v.type === 'number'){
      const n = typeof val === 'string' ? Number(val) : val;
      if (!Number.isFinite(n)) return { error: `${name}: ${k} 必须是数字` };
      a[k] = Math.round(n);
      if (v.minimum != null && a[k] < v.minimum) return { error: `${name}: ${k} 不能小于 ${v.minimum}` };
      if (v.maximum != null && a[k] > v.maximum) return { error: `${name}: ${k} 不能大于 ${v.maximum}` };
    } else if (v.type === 'string'){
      if (typeof val !== 'string') return { error: `${name}: ${k} 必须是字符串` };
      if (v.enum && !v.enum.includes(val)) return { error: `${name}: ${k} 只能是 ${v.enum.join(' / ')}` };
      if (v.minLength != null && val.trim().length < v.minLength) return { error: `${name}: ${k} 不能为空` };
    } else if (v.type === 'boolean'){
      a[k] = val === true || val === 'true';
    }
  }
  for (const req of tool.inputSchema.required || []){
    if (a[req] === undefined || a[req] === '') return { error: `${name}: 缺少必填参数 ${req}` };
  }
  return { args: a };
}

export async function callTool(name, args){
  const norm = normalize(name, args);
  if (norm.error) return { content: [{ type: 'text', text: norm.error }], isError: true };
  try {
    const obj = await TOOLS.find(t => t.name === name).run(norm.args);
    return { content: [{ type: 'text', text: JSON.stringify(obj, null, 1) }] };
  } catch (e){
    return { content: [{ type: 'text', text: `工具执行失败：${e && e.message ? e.message : String(e)}` }], isError: true };
  }
}
