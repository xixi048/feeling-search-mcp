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

Two ways, both are the whole setup — no API key, no account, no local data download.

**Remote (no install, recommended)** — point the client at the endpoint:

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

**Local (stdio via npm)** — the few-KB bridge package:

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

Machine-readable copy of both variants: [`mcp.json`](./mcp.json).
Registry and directory crawlers can read that file directly instead of parsing this README.
MCP 服务配置见仓库根的 `mcp.json`（远端 Streamable HTTP 与本地 stdio 两种写法都在里面）。

## Tools

| Tool | What it does | Cost |
|---|---|---|
| `word_analyze` | One sentence → the best-matching visual styles + the feeling words behind them | free (local tier) |
| `word_lookup` | Look up a single feeling word: definition, near-synonyms, landing styles | free |
| `word_list` | Browse / search the full feeling-word lexicon | free |
| `style_get` | One style in full: definition, parent style, member words, reference images | free |
| `word_status` | Lexicon version, coverage — use it to check the data is fresh | free |

Every tool is read-only and costs nothing. The paid `/v2/analyze` cloud path is **off by
default** on the public endpoint and only runs when a caller explicitly opts in.

## Why a bridge, not a bundled server

This package is a thin stdio ↔ HTTP bridge to `https://xiximm.cloud/mcp`. The lexicon and
matching logic live in exactly one place, so the package can never drift from the data:

- **Nothing to download** — the package is a few KB; the whole corpus stays server-side
- **Always current** — a lexicon update is live the moment the site deploys, no `npm update`
- **Tiny audit surface** — no `eval`/`exec`/`subprocess`, no filesystem writes, one outbound host

If you need a fully offline server, run the project's own `mcp/stdio.mjs` from a checkout
with the data directory present.

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
