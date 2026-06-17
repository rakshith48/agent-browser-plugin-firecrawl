# agent-browser-plugin-firecrawl

A [agent-browser](https://github.com/vercel-labs/agent-browser) plugin that integrates [Firecrawl](https://firecrawl.dev). It speaks the `agent-browser.plugin.v1` stdio protocol and exposes Firecrawl two ways:

- **`browser.provider`** — launches a Firecrawl **cloud browser session** and returns its CDP WebSocket URL, so agent-browser drives Firecrawl's managed Chrome (proxies, anti-bot, persistent login profiles, live view). Firecrawl becomes a remote browser backend, peer to Browserbase/Browserless/Kernel.
- **`command.run`** — calls Firecrawl's **scrape / search / crawl / map / parse** endpoints directly, without launching a browser session.

## Requirements

- Node.js ≥ 18 (uses the built-in `fetch`).
- A Firecrawl API key in the `FIRECRAWL_API_KEY` environment variable. Get one at [firecrawl.dev](https://www.firecrawl.dev/).

> Never put the API key in `agent-browser.json` `args`. agent-browser reads it from the plugin's environment.

## Install

From GitHub (current):

```bash
agent-browser plugin add firecrawl/agent-browser-plugin-firecrawl
```

From npm (once published):

```bash
agent-browser plugin add agent-browser-plugin-firecrawl
```

`plugin add` runs the package once, reads its `plugin.manifest`, and writes the config to `./agent-browser.json` (use `--global` for `~/.agent-browser/config.json`). Verify:

```bash
agent-browser plugin list
agent-browser plugin show firecrawl
```

## Use it

### As a browser provider

```bash
export FIRECRAWL_API_KEY=fc-...
agent-browser --provider firecrawl open https://example.com
agent-browser snapshot
agent-browser click @e2
agent-browser close
```

agent-browser asks the plugin for a session (`POST /v2/interact`), connects to the returned `cdpUrl`, and drives it with its full command surface. On `close` (or a failed connect) the plugin deletes the session (`DELETE /v2/interact/{id}`).

### As scrape/search/crawl/map/parse commands

```bash
agent-browser plugin run firecrawl firecrawl.scrape --payload '{"url":"https://example.com","formats":["markdown"]}'
agent-browser plugin run firecrawl firecrawl.search --payload '{"query":"firecrawl agent browser","limit":5}'
agent-browser plugin run firecrawl firecrawl.crawl  --payload '{"url":"https://docs.example.com"}'
agent-browser plugin run firecrawl firecrawl.map    --payload '{"url":"https://example.com"}'
```

For these, the `--payload` JSON is forwarded as the request body to the matching Firecrawl `/v2` endpoint; the response is returned under `data`.

**Parse a local document** (`POST /v2/parse`, `multipart/form-data`). Pass a local `file` path (read from disk by the plugin) and optional scrape-style `options`:

```bash
agent-browser plugin run firecrawl firecrawl.parse --payload '{"file":"./report.pdf","options":{"formats":["markdown"]}}'
```

Use `parse` for local or non-public files (PDF, DOCX, XLSX, HTML, …); for a public document URL, prefer `firecrawl.scrape`.

## Configuration

`plugin add` writes this for you, but you can edit `agent-browser.json` manually:

```json
{
  "plugins": [
    {
      "name": "firecrawl",
      "command": "agent-browser-plugin-firecrawl",
      "capabilities": [
        "browser.provider",
        "command.run",
        "firecrawl.scrape",
        "firecrawl.search",
        "firecrawl.crawl",
        "firecrawl.map",
        "firecrawl.parse"
      ]
    }
  ]
}
```

> When added from GitHub, `plugin add` instead writes `"command": "npx"` with `"args": ["-y", "github:firecrawl/agent-browser-plugin-firecrawl"]`. The npm-installed form above uses the global `bin`.

### Environment variables

The plugin reuses Firecrawl's standard env vars — the **same ones the Firecrawl CLI and SDK use** — so if Firecrawl is already set up in your shell, the plugin works with no extra config.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `FIRECRAWL_API_KEY` | yes\* | — | Firecrawl API key (`fc-...`). Authenticates the plugin to the Firecrawl API. |
| `FIRECRAWL_API_URL` | no | `https://api.firecrawl.dev` | Override for self-hosted Firecrawl (no key required for local instances). |
| `FIRECRAWL_PROFILE_NAME` | no | — | Persistent browser profile to load (cookies/localStorage/login state). |
| `FIRECRAWL_PROFILE_SAVE_CHANGES` | no | `true` | Save browser state back to the profile on close. Set `false`/`0` for read-only. |

\* Not required if you've run `firecrawl login` (see below) or are pointing `FIRECRAWL_API_URL` at a self-hosted instance.

### Credential resolution

The plugin resolves its Firecrawl API key in this order:

1. **`FIRECRAWL_API_KEY` env var** (and `FIRECRAWL_API_URL`) — explicit, always wins.
2. **`firecrawl login` session** — if you've authenticated with the [Firecrawl CLI](https://github.com/firecrawl/cli) (browser or API key), the plugin reads the key it stored in `credentials.json` (`~/Library/Application Support/firecrawl-cli` on macOS, `~/.config/firecrawl-cli` on Linux, `%AppData%/firecrawl-cli` on Windows). No env var needed.
3. Otherwise it returns a clear error: *set `FIRECRAWL_API_KEY` or run `firecrawl login`*.

One key serves both the browser provider and the scrape/search/crawl/map commands.

### Two auth layers

- **API auth (plugin → Firecrawl):** `FIRECRAWL_API_KEY` env var, or a reused `firecrawl login` session (see above) — same env-var convention as the built-in Browserbase/Browserless/Kernel providers.
- **Browser auth (session → target site):** Firecrawl **persistent profiles**. Set `FIRECRAWL_PROFILE_NAME` (or pass `profile` in the launch request) to log in once and reuse the session:

  ```bash
  # First run: log in, state is saved to the profile
  FIRECRAWL_PROFILE_NAME=my-app agent-browser --provider firecrawl open https://app.example.com/login
  # ... drive the login with agent-browser, then close ...

  # Later runs: already authenticated
  FIRECRAWL_PROFILE_NAME=my-app FIRECRAWL_PROFILE_SAVE_CHANGES=false \
    agent-browser --provider firecrawl open https://app.example.com/dashboard
  ```

### Browser session options

The `browser.launch` request forwards these fields (when present) to `POST /v2/interact`: `ttl`, `activityTtl`, `streamWebView`, and `profile` (`{ name, saveChanges }`). If the request has no `profile`, the `FIRECRAWL_PROFILE_NAME` env var is used.

## Policy gating

Each capability is a policy action `plugin:firecrawl:<capability>`:

```bash
agent-browser --confirm-actions plugin:firecrawl:browser.provider --provider firecrawl open https://example.com
```

## Develop & test

### Unit tests (no API key, no network)

Hermetic tests spawn the bin and mock the Firecrawl API on localhost — they cover the protocol paths and the `browser.launch` request mapping:

```bash
npm test          # node --test
```

Quick manual checks:

```bash
npm run manifest  # prints the plugin manifest
echo '{"protocol":"agent-browser.plugin.v1","type":"firecrawl.scrape","capability":"command.run","request":{"url":"https://example.com","formats":["markdown"]}}' \
  | FIRECRAWL_API_KEY=fc-... node bin/plugin.js
```

### End-to-end (real Firecrawl + agent-browser)

```bash
# 0. prerequisites
npm install -g agent-browser
export FIRECRAWL_API_KEY=fc-...

# 1. install + inspect the plugin
agent-browser plugin add firecrawl/agent-browser-plugin-firecrawl
agent-browser plugin list
agent-browser plugin show firecrawl

# 2. browser.provider — drive Firecrawl's cloud browser
agent-browser --provider firecrawl open https://example.com
agent-browser get title
agent-browser snapshot -i          # note the @e refs, then click one
agent-browser click @e2
agent-browser get url              # should have navigated
agent-browser close

# 3. command.run — scrape / search / crawl / map
agent-browser plugin run firecrawl firecrawl.scrape --payload '{"url":"https://example.com","formats":["markdown"]}'
agent-browser plugin run firecrawl firecrawl.search --payload '{"query":"firecrawl","limit":3}'

# 4. persistent profile — log in once, reuse
FIRECRAWL_PROFILE_NAME=my-app agent-browser --provider firecrawl open https://app.example.com/login
# ...drive the login with snapshot/click/fill, then close to save state...
agent-browser close
FIRECRAWL_PROFILE_NAME=my-app FIRECRAWL_PROFILE_SAVE_CHANGES=false \
  agent-browser --provider firecrawl open https://app.example.com/dashboard
agent-browser close

# 5. confirm no sessions leaked
curl -s "https://api.firecrawl.dev/v2/interact?status=active" -H "Authorization: Bearer $FIRECRAWL_API_KEY"
```

> `snapshot` refs (`@e1`, `@e2`, …) are assigned per snapshot — always take a fresh snapshot in the current session before clicking a ref.

## License

MIT
