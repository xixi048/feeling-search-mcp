# Installing feeling-search on Cline

`feeling-search` is an MCP server that turns one colloquial sentence into the visual art style
that matches it, plus the feeling words that led there. Five read-only tools, no API key.

Two ways to install. **Prefer the remote server** — nothing to download, always current.

---

## Option A — Remote server (recommended)

The endpoint speaks Streamable HTTP and requires no authentication.

1. Open the **MCP Servers** panel in Cline → **Remote Servers** tab.
2. Fill in:

   | Field | Value |
   |---|---|
   | Name | `feeling-search` |
   | URL | `https://xiximm.cloud/mcp` |
   | Transport | `streamableHttp` |

3. Save. Cline connects immediately; the panel shows the 5 tools.

If the UI path is unavailable, write into the MCP settings file
(`cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "feeling-search": {
      "url": "https://xiximm.cloud/mcp",
      "transportType": "streamableHttp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Notes:

- No `Authorization` header, no token, no OAuth. Do not add one.
- If the client rejects `url`-style entries and demands `command`/`args`, use Option B.
- `type: "sse"` also works on this endpoint, but `streamableHttp` is preferred.

---

## Option B — Local stdio via npx

1. Check Node.js is present: `node -v` → must be ≥ 18.
2. Add this entry to `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "feeling-search": {
      "command": "npx",
      "args": ["-y", "feeling-search-mcp"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

The package is a few KB and is a thin stdio ↔ HTTP bridge to the same endpoint. It writes
nothing to disk, runs no `eval`/`exec`, and only talks to `xiximm.cloud`.

If `npx` is unavailable, `npm i -g feeling-search-mcp` and use
`{"command": "feeling-search-mcp", "args": []}` instead.

---

## Verify the install

Ask Cline to call `word_status` (no arguments). A working server returns the lexicon version,
the word/style counts, and the quota state. Do not use a paid call to test.

Then try a real one:

```json
{ "tool": "word_analyze", "arguments": { "text": "下雨天一个人走在便利店门口，冷白灯光" } }
```

Expected: feeling words such as 星光 / 窗光 / 冷光, and visual styles such as 垂直式哥特 / 星图.
Both Chinese and English sentences are accepted.

---

## Tool reference

| Tool | Arguments | Returns |
|---|---|---|
| `word_analyze` | `text` (required), `limit`, `allow_cloud` | Matched feeling words with weights, plus visual styles with reference images |
| `word_lookup` | `word` | One feeling word: definition, near-synonyms, antonyms, landing styles |
| `word_list` | `kind` (`word` \| `style`), `query`, `limit` | Browse / search the lexicon |
| `style_get` | `id` or `name` | One style in full: definition, prompt, member words, reference images |
| `word_status` | — | Lexicon version, sizes, free quota |

All tools are read-only and free. The paid cloud path (`allow_cloud: true`) is off by default
and costs money per call — never set it during install testing.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `fetch failed` / connection refused | Confirm `curl -s -o /dev/null -w "%{http_code}" https://xiximm.cloud/mcp` returns `200` |
| `initialize` succeeds but `tools/list` returns `[]` | Client cached an old handshake — restart the MCP server entry |
| npx path fails behind a proxy | Use Option A (remote), or set `HTTP_PROXY` before launching |
| Tool call returns a 402 | `allow_cloud` was set to `true` without quota. Drop the flag; the local tier is free |
