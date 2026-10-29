# feeling-search-mcp

> MCP server for [feeling-search](https://xiximm.cloud) — turn one colloquial sentence into the
> visual style that matches it best, plus the feeling words that led there. Every style carries
> its name, a one-line definition and the words that triggered it.

A commercial-grade art reference chart, art-style encyclopedia and art-style AI prompt
dictionary, exposed over the Model Context Protocol.

```
"下雨天一个人走在便利店门口，冷白灯光"
   → 感受词：星光 / 窗光 / 冷光 …
   → 视觉风格：垂直式哥特 / 星图 / 托莱多画派 …
```

## Install

Two shapes. Neither needs an account or an API key.

**Local (default, recommended)** — the package now ships the whole thing: 762-word lexicon,
the 598-style index, and **both** semantic engines. It runs offline.

```json
{
  "mcpServers": {
    "feeling-search": {
      "command": "npx",
      "args": ["-y", "feeling-search-mcp"]
    }
  }
}
```

First `npx` run downloads ~21 MB (the two engines are 8 MB zh + 10 MB en). After that:
lexicon hits answer in ~10 ms, whole-sentence queries in ~25 ms, all on your machine.

**Remote (no download)** — point the client at the endpoint:

```json
{
  "mcpServers": {
    "feeling-search": {
      "type": "streamableHttp",
      "url": "https://xiximm.cloud/mcp"
    }
  }
}
```

Or keep the local install but forward: `npx feeling-search-mcp --remote`. Remote answers in
0.76–1.64 s (network round trip + cold start), local in 10–90 ms, and local never sends your
text anywhere.

Machine-readable copy of both variants: [`mcp.json`](./mcp.json).

## Tools

| Tool | What it does | Cost |
|---|---|---|
| `word_analyze` | One sentence → the best-matching visual styles + the feeling words behind them. `source` tells you which layer answered (`local` lexicon / `engine` semantic model / `cloud` fallback) | free, offline |
| `word_lookup` | Look up a single feeling word: definition, near-synonyms, landing styles | free |
| `word_list` | Browse / search the full feeling-word lexicon | free |
| `style_get` | One style in full: definition, parent style, member words, reference images | free |
| `word_status` | Lexicon version, coverage — use it to check the data is fresh | free |

Every tool is read-only and costs nothing. The paid `/v2/analyze` cloud path is **off by
default** on the public endpoint and only runs when a caller explicitly opts in.

> **Pricing status (2026-10-28): everything is free — no API key, no quota token.** The upstream
> service runs free by default; paid 402 / x402 is only enabled if the operator explicitly sets
> `FS_PAID=1`. Only rate limits apply: 20 requests/minute per IP, and `POST /v2/analyze` is capped
> at 200 calls per visitor per day. Nothing in this bridge needs to change either way.

Want to know how much traffic the lexicon is getting? The upstream exposes a public
`GET /v2/stats` telemetry endpoint (page views, unique visitors, referrers, AI crawler hits, no
personal data) — see <https://xiximm.cloud/docs/api.html>.

## Two layers, and which one answers

`word_analyze` only escalates when it has to:

| Layer | When it runs | Latency | What it returns |
|---|---|---|---|
| **Lexicon** (`source: "local"`) | The sentence contains 2+ lexicon words | ~10 ms | Exact feeling words, each with its landing styles |
| **Semantic engine** (`source: "engine"`) | The lexicon hits 0–1 words — i.e. it didn't really understand the sentence | ~25 ms | Real words from the 762-entry lexicon (cosine against 762 word vectors) + styles ranked against 598 style vectors |
| **Cloud** (`source: "cloud"`) | Only on the remote endpoint, and only with `allow_cloud: true` | 0.8–1.6 s | Paid fallback |

Two engines, picked by language:

- **Chinese** — ask in whole Chinese sentences. Any Han character makes it the Chinese engine;
  don't mix, e.g. `有点 lonely 的雨夜` gets shredded by the Chinese tokenizer.
- **English** — ask in whole English sentences. `moody rainy night in old Hong Kong`.
- Force one with `lang: "zh" | "en"`; default is `auto`.

Negation is computed outside the model and is deterministic: `不要压抑` drops 压抑 and demotes
every style that carries it, on both layers.

## What's in the package

| Path | Size | Why |
|---|---|---|
| `data/src/words.json`, `data/standards/*.json` | ~2 MB | Lexicon, 598 styles, aliases, version |
| `data/standards/zh-engine/` | 8.1 MB | Chinese ternary engine (wasm core + weights) |
| `data/standards/ternlight/` | 9.8 MB | English engine (wasm, weights embedded) |
| `data/standards/idx/` | 0.9 MB | 598 style vectors, per language, int8 |
| `lib/` | <100 KB | Tool definitions, engine loader, lexicon |

Everything is generated from the upstream repo by `deploy/pack-mcp.mjs`, which also runs a
`--check` drift comparison — the package can't silently fall behind the data.

## Endpoint

| Property | Value |
|---|---|
| Transport | Streamable HTTP (`sse` also accepted) |
| URL | `https://xiximm.cloud/mcp` |
| Auth | none — anonymous `initialize` and `tools/list` both succeed |
| Tools | 5 (`word_analyze`, `word_lookup`, `word_list`, `style_get`, `word_status`) |
| npm package | `feeling-search-mcp` |
| MCP Registry name | `cloud.xiximm/feeling-search` |

## Configuration

| Env / flag | Default | Meaning |
|---|---|---|
| `FS_MCP_URL` / `--endpoint` | `https://xiximm.cloud/mcp` | Endpoint to bridge to |
| `FS_MCP_TOKEN` | unset | Sent as `Authorization: Bearer <token>` when the endpoint is gated |
| `--timeout` | `30000` | Per-request timeout in ms |
| `--remote` | off | Forward to the endpoint instead of running locally |
| `--data <dir>` / `FS_DATA_ROOT` | package `data/` | Where the lexicon and engines live |

`stdout` carries protocol messages only; all diagnostics go to `stderr`.

## Reach & traffic

One command checks every channel this package is listed on — npm downloads, GitHub traffic
and referrers, MCP Registry versions, directory availability, and open PRs:

```bash
node scripts/traffic.mjs          # human-readable report
node scripts/traffic.mjs --json   # machine-readable, for diffing over time
```

Requires the `gh` CLI to be logged in (GitHub traffic needs push permission on the repo).
Mind the reporting lag: npm download stats appear 24–48h after the first publish, and
GitHub traffic only covers the last 14 days.

`referrers` is the useful signal for directories — it shows which registry actually sends
visitors. Directory sites themselves publish no view counts.

## Related

- Agent skill: [`xixi048/feeling-search-skill`](https://github.com/xixi048/feeling-search-skill) — same vocabulary, works offline from a local cache
- Site + API: [xiximm.cloud](https://xiximm.cloud/docs/api.html)

## License

MIT
