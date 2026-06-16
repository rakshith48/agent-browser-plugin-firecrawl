#!/usr/bin/env node
"use strict";

/**
 * agent-browser-plugin-firecrawl
 *
 * An agent-browser plugin (protocol `agent-browser.plugin.v1`) that exposes
 * Firecrawl in two ways:
 *
 *   1. browser.provider  — launch a Firecrawl cloud browser session and hand
 *      agent-browser its CDP WebSocket URL, so agent-browser drives Firecrawl's
 *      managed Chrome (proxies, anti-bot, persistent login profiles, live view).
 *
 *   2. command.run        — call Firecrawl's scrape/search/crawl/map endpoints
 *      directly from agent-browser via `plugin run firecrawl firecrawl.<x>`.
 *
 * Protocol contract: read exactly one JSON request from stdin, write exactly
 * one JSON response to stdout, and exit 0. Nothing else may go to stdout.
 */

const PROTOCOL = "agent-browser.plugin.v1";
const API_BASE = (process.env.FIRECRAWL_API_URL || "https://api.firecrawl.dev").replace(/\/+$/, "");
const API_KEY = process.env.FIRECRAWL_API_KEY || "";

const CAPABILITIES = [
  "browser.provider",
  "command.run",
  "firecrawl.scrape",
  "firecrawl.search",
  "firecrawl.crawl",
  "firecrawl.map",
];

// command.run request type -> Firecrawl endpoint
const COMMANDS = {
  "firecrawl.scrape": "/v2/scrape",
  "firecrawl.search": "/v2/search",
  "firecrawl.crawl": "/v2/crawl",
  "firecrawl.map": "/v2/map",
};

function write(body) {
  process.stdout.write(JSON.stringify({ protocol: PROTOCOL, ...body }));
}
function ok(body) {
  write({ success: true, ...body });
}
function fail(error) {
  write({ success: false, error: String(error && error.message ? error.message : error) });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function api(method, path, body) {
  if (!API_KEY) throw new Error("FIRECRAWL_API_KEY is not set");
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok || json.success === false) {
    const msg = json && json.error ? json.error : `HTTP ${res.status}`;
    throw new Error(`Firecrawl ${method} ${path} failed: ${msg}`);
  }
  return json;
}

// Forward only the session fields Firecrawl's POST /v2/browser understands.
function browserCreateBody(request) {
  const r = request && typeof request === "object" ? request : {};
  const body = {};
  if (r.ttl != null) body.ttl = r.ttl;
  if (r.activityTtl != null) body.activityTtl = r.activityTtl;
  if (r.streamWebView != null) body.streamWebView = r.streamWebView;
  if (r.profile != null) body.profile = r.profile;
  return body;
}

async function handle(input) {
  const type = input.type;

  // --- discovery ---
  if (type === "plugin.manifest") {
    return ok({
      manifest: {
        name: "firecrawl",
        capabilities: CAPABILITIES,
        description:
          "Firecrawl cloud browser provider (CDP) plus scrape/search/crawl/map commands",
      },
    });
  }

  // --- browser.provider ---
  if (type === "browser.launch") {
    const session = await api("POST", "/v2/browser", browserCreateBody(input.request));
    if (!session.cdpUrl) throw new Error("Firecrawl did not return a cdpUrl");
    return ok({
      browser: {
        cdpUrl: session.cdpUrl,
        directPage: false,
        metadata: {
          sessionId: session.id,
          liveViewUrl: session.liveViewUrl,
          interactiveLiveViewUrl: session.interactiveLiveViewUrl,
          expiresAt: session.expiresAt,
        },
        // Sent back to us as the browser.close request if connect fails.
        cleanup: { sessionId: session.id },
      },
    });
  }

  if (type === "browser.close") {
    const r = input.request && typeof input.request === "object" ? input.request : {};
    const id = r.sessionId || r.id;
    if (id) await api("DELETE", `/v2/browser/${encodeURIComponent(id)}`);
    return ok({});
  }

  // --- command.run (scrape/search/crawl/map) ---
  if (COMMANDS[type]) {
    const data = await api("POST", COMMANDS[type], input.request || {});
    return ok({ data });
  }

  return fail(`unsupported request type: ${type}`);
}

(async () => {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return fail("invalid JSON request");
  }
  if (!input || input.protocol !== PROTOCOL) {
    return fail("unsupported protocol");
  }
  try {
    await handle(input);
  } catch (err) {
    fail(err);
  }
})();
