# agent-browser-plugin-firecrawl

A [agent-browser](https://github.com/vercel-labs/agent-browser) plugin that integrates [Firecrawl](https://firecrawl.dev). It speaks the `agent-browser.plugin.v1` stdio protocol and exposes Firecrawl two ways:

- **`browser.provider`** — launches a Firecrawl **cloud browser session** and returns its CDP WebSocket URL, so agent-browser drives Firecrawl's managed Chrome (proxies, anti-bot, persistent login profiles, live view). Firecrawl becomes a remote browser backend, peer to Browserbase/Browserless/Kernel.
- **`command.run`** — calls Firecrawl's **scrape / search / crawl / map** endpoints directly, without launching a browser session.

## Requirements

- Node.js ≥ 18 (uses the built-in `fetch`).
- A Firecrawl API key in the `FIRECRAWL_API_KEY` environment variable. Get one at [firecrawl.dev](https://www.firecrawl.dev/).

> Never put the API key in `agent-browser.json` `args`. agent-browser reads it from the plugin's environment.

## Install

From GitHub (current):

```bash
agent-browser plugin add rakshith48/agent-browser-plugin-firecrawl
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

agent-browser asks the plugin for a session (`POST /v2/browser`), connects to the returned `cdpUrl`, and drives it with its full command surface. On `close` (or a failed connect) the plugin deletes the session (`DELETE /v2/browser/{id}`).

### As scrape/search/crawl/map commands

```bash
agent-browser plugin run firecrawl firecrawl.scrape --payload '{"url":"https://example.com","formats":["markdown"]}'
agent-browser plugin run firecrawl firecrawl.search --payload '{"query":"firecrawl agent browser","limit":5}'
agent-browser plugin run firecrawl firecrawl.crawl  --payload '{"url":"https://docs.example.com"}'
agent-browser plugin run firecrawl firecrawl.map    --payload '{"url":"https://example.com"}'
```

The `--payload` JSON is forwarded as the request body to the matching Firecrawl `/v2` endpoint; the Firecrawl response is returned under `data`.

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
        "firecrawl.map"
      ]
    }
  ]
}
```

### Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `FIRECRAWL_API_KEY` | yes | — | Firecrawl API key (`fc-...`). |
| `FIRECRAWL_API_URL` | no | `https://api.firecrawl.dev` | Override for self-hosted Firecrawl. |

### Browser session options

The `browser.launch` request forwards these fields (when present) to `POST /v2/browser`: `ttl`, `activityTtl`, `streamWebView`, `profile` (`{ name, saveChanges }` for persistent login state).

## Policy gating

Each capability is a policy action `plugin:firecrawl:<capability>`:

```bash
agent-browser --confirm-actions plugin:firecrawl:browser.provider --provider firecrawl open https://example.com
```

## Develop / test

The manifest path needs no API key or network:

```bash
npm run manifest
# {"protocol":"agent-browser.plugin.v1","success":true,"manifest":{...}}
```

Drive any request type by piping a request envelope to the bin:

```bash
echo '{"protocol":"agent-browser.plugin.v1","type":"firecrawl.scrape","capability":"command.run","request":{"url":"https://example.com","formats":["markdown"]}}' \
  | FIRECRAWL_API_KEY=fc-... node bin/plugin.js
```

## License

MIT
