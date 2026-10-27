#!/usr/bin/env node
/**
 * traffic.mjs —— feeling-search 全渠道流量与收录自检
 *
 * 用法：
 *   node scripts/traffic.mjs            # 完整报告
 *   node scripts/traffic.mjs --json     # 机器可读，便于存档比对
 *
 * 零第三方依赖。GitHub 部分走本机已登录的 gh CLI（token 不出现在代码里）。
 *
 * 指标口径与滞后（重要，别把「0」当成「没人用」）：
 *   npm downloads   新包发布后约 24–48h 才出统计，之前一律 404/空
 *   GitHub traffic  只保留最近 14 天，且需仓库 push 权限；当天数据可能未汇总
 *   官方 Registry   完全没有统计接口，只能看版本与 active 状态
 *   目录站/商店      多数不公开浏览量；能看的是「是否已收录」
 *   站点            Clarity / EdgeOne 控制台里看
 *   真实调用量      只有自己的 /mcp 端点日志知道——这是唯一能证明「有人在用」的数据
 */

import { execSync } from "node:child_process";

const REPO = "xixi048/feeling-search-mcp";
const SKILL_REPO = "xixi048/feeling-search-skill";
const NPM_PKG = "feeling-search-mcp";
const REGISTRY_NAME = "cloud.xiximm%2Ffeeling-search";
const SITE = "https://xiximm.cloud";
const MODELSCOPE = "https://www.modelscope.cn/mcp/servers/xixi048/feeling-search";

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");

async function safe(label, fn, fallback = null) {
  try {
    return await fn();
  } catch (e) {
    if (!asJson) console.error(`  ! ${label}: ${String(e.message || e).slice(0, 80)}`);
    return fallback;
  }
}

function gh(path) {
  const out = execSync(`gh api "${path}"`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out);
}

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function head(url) {
  const r = await fetch(url, { method: "GET", redirect: "follow" });
  return r.status;
}

/** npm：新包没数据时 API 返回 { error: "package ... not found" } */
async function npmStats() {
  const version = await getJson(`https://registry.npmjs.org/${NPM_PKG}/latest`).then((j) => j.version);
  const points = {};
  for (const period of ["last-day", "last-week", "last-month"]) {
    points[period] = await safe(`npm ${period}`, async () => {
      const j = await getJson(`https://api.npmjs.org/downloads/point/${period}/${NPM_PKG}`);
      return j.error ? null : j.downloads;
    });
  }
  return { version, downloads: points };
}

async function repoStats(repo) {
  const meta = await gh(`repos/${repo}`);
  const out = {
    stars: meta.stargazers_count,
    forks: meta.forks_count,
    watchers: meta.subscribers_count,
    views: null,
    clones: null,
    referrers: [],
  };
  const views = await safe(`${repo} views`, () => gh(`repos/${repo}/traffic/views`));
  if (views) out.views = { count: views.count, uniques: views.uniques };
  const clones = await safe(`${repo} clones`, () => gh(`repos/${repo}/traffic/clones`));
  if (clones) out.clones = { count: clones.count, uniques: clones.uniques };
  const refs = await safe(`${repo} referrers`, () => gh(`repos/${repo}/traffic/popular/referrers`));
  if (refs) out.referrers = refs.map((r) => ({ from: r.referrer, count: r.count, uniques: r.uniques }));
  return out;
}

async function registryStats() {
  const j = await getJson(`https://registry.modelcontextprotocol.io/v0/servers/${REGISTRY_NAME}/versions`);
  return (j.servers || []).map((x) => ({
    version: x.server?.version,
    status: x._meta?.["io.modelcontextprotocol.registry/official"]?.status ?? "?",
    // 旧版本仍会 active；这里顺手暴露它是否还挂着过期文案
    description: x.server?.description,
  }));
}

function ghPr(repo, n) {
  const j = gh(`repos/${repo}/pulls/${n}`);
  return { n, repo, state: j.state, title: (j.title || "").slice(0, 40), created: j.created_at };
}

const report = {};

report.npm = await safe("npm", npmStats, {});
report.site = await safe("site", async () => ({ status: await head(SITE) }), {});
report.modelscope = await safe("modelscope", async () => ({ status: await head(MODELSCOPE) }), {});
report.registry = await safe("registry", registryStats, []);
report.mcpRepo = await safe("mcpRepo", () => repoStats(REPO), {});
report.skillRepo = await safe("skillRepo", () => repoStats(SKILL_REPO), {});
report.prs = await safe(
  "prs",
  () => [ghPr("yzfly/Awesome-MCP-ZH", 860), ghPr("davepoon/buildwithclaude", 569), ghPr("VoltAgent/awesome-agent-skills", 1276)],
  []
);

if (asJson) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2));
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
const num = (v) => (v === null || v === undefined ? "暂无" : String(v));

console.log(`\nfeeling-search · 渠道与流量自检   ${new Date().toLocaleString("zh-CN")}`);
console.log("=".repeat(66));

console.log("\n[npm]");
console.log(`  版本        ${num(report.npm?.version)}`);
const d = report.npm?.downloads || {};
console.log(`  下载 今日   ${num(d["last-day"])}   本周 ${num(d["last-week"])}   本月 ${num(d["last-month"])}`);
if (d["last-month"] === null) {
  console.log("  说明        新包发布不足 24–48h，官方统计还没生成，不是零下载");
}

console.log("\n[GitHub]");
for (const [name, key] of [["MCP 仓库", "mcpRepo"], ["Skill 仓库", "skillRepo"]]) {
  const r = report[key] || {};
  console.log(`  ${pad(name, 10)} ★${num(r.stars)}  fork ${num(r.forks)}  watch ${num(r.watchers)}`);
  console.log(`  ${pad("", 10)} 浏览 ${num(r.views?.count)} 次 / ${num(r.views?.uniques)} 人   克隆 ${num(r.clones?.count)} 次`);
  if (r.referrers?.length) {
    console.log(`  ${pad("", 10)} 来源：${r.referrers.map((x) => `${x.from}(${x.uniques})`).join("  ")}`);
  }
}

console.log("\n[官方 MCP Registry]");
for (const v of report.registry || []) {
  const stale = /762|598/.test(v.description || "") ? "  ⚠ 描述含过期数字" : "";
  console.log(`  ${pad(v.version, 8)} ${v.status}${stale}`);
}

console.log("\n[站点与平台可达]");
console.log(`  ${pad("xiximm.cloud", 24)} ${num(report.site?.status)}`);
console.log(`  ${pad("魔搭 MCP 详情页", 24)} ${num(report.modelscope?.status)}`);

console.log("\n[待审 PR]");
for (const p of report.prs || []) {
  console.log(`  #${pad(p.n, 5)} ${pad(p.state, 7)} ${p.repo}`);
}

console.log("\n" + "=".repeat(66));
console.log("口径提醒：GitHub traffic 只有 14 天窗口；目录站基本不公开浏览量，");
console.log("能判断效果的是 referrers——它告诉你访客是从哪个目录点进来的。");
console.log("真正能证明「有人在用」的数据只有你自己 /mcp 端点的调用日志。\n");
