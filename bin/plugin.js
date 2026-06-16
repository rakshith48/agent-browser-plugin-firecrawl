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

const fs = require("node:fs");
const os = require("node:os");
const nodePath = require("node:path");

const PROTOCOL = "agent-browser.plugin.v1";
const DEFAULT_API_BASE = "https://api.firecrawl.dev";

// Location where firecrawl-cli stores credentials after `firecrawl login`
// (mirrors cli/src/utils/credentials.ts). Lets a logged-in user skip the env var.
function cliConfigDir() {
  const home = os.homedir();
  switch (os.platform()) {
    case "darwin":
      return nodePath.join(home, "Library", "Application Support", "firecrawl-cli");
    case "win32":
      return nodePath.join(home, "AppData", "Roaming", "firecrawl-cli");
    default:
      return nodePath.join(home, ".config", "firecrawl-cli");
  }
}

function loadCliCredentials() {
  try {
    const raw = fs.readFileSync(nodePath.join(cliConfigDir(), "credentials.json"), "utf8");
    const c = JSON.parse(raw);
    return c && typeof c === "object" ? c : null;
  } catch {
    return null; // missing/unreadable/corrupt -> no stored creds
  }
}

// Resolve credentials: explicit env wins, then fall back to the `firecrawl login`
// session stored by the CLI. Same key serves browser.provider and command.run.
function resolveCredentials() {
  const stored = loadCliCredentials() || {};
  const apiKey = process.env.FIRECRAWL_API_KEY || stored.apiKey || "";
  const apiUrl = process.env.FIRECRAWL_API_URL || stored.apiUrl || DEFAULT_API_BASE;
  return { apiKey, apiBase: String(apiUrl).replace(/\/+$/, "") };
}

const CAPABILITIES = [
  "browser.provider",
  "command.run",
  "firecrawl.scrape",
  "firecrawl.search",
  "firecrawl.crawl",
  "firecrawl.map",
  "firecrawl.parse",
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
  const { apiKey, apiBase } = resolveCredentials();
  if (!apiKey) {
    throw new Error("No Firecrawl credentials: set FIRECRAWL_API_KEY or run `firecrawl login`");
  }
  // Bound the request so a stalled call can't block the plugin from emitting
  // its single response. Overridable via FIRECRAWL_HTTP_TIMEOUT_MS.
  const controller = new AbortController();
  const timeoutMs = Number(process.env.FIRECRAWL_HTTP_TIMEOUT_MS) || 60000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // FormData bodies (e.g. /v2/parse uploads) must keep fetch's auto-generated
  // multipart Content-Type/boundary — only set JSON content-type otherwise.
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  let res;
  try {
    res = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body && !isForm ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error(`Firecrawl ${method} ${path} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
// agent-browser sends `{ provider, session, launchOptions: {...} }`, so known
// Firecrawl params may arrive nested under launchOptions (or top-level when the
// plugin is driven directly). Merge both, launchOptions taking precedence.
function browserCreateBody(request) {
  const r = request && typeof request === "object" ? request : {};
  const opts = r.launchOptions && typeof r.launchOptions === "object" ? r.launchOptions : {};
  const src = { ...r, ...opts };
  const body = {};
  if (src.ttl != null) body.ttl = src.ttl;
  if (src.activityTtl != null) body.activityTtl = src.activityTtl;
  if (src.streamWebView != null) body.streamWebView = src.streamWebView;
  // Persistent login profile (Layer 2 / browser auth). An explicit profile in
  // the launch request wins; otherwise fall back to env, mirroring how the
  // built-in Kernel provider reads KERNEL_PROFILE_NAME.
  if (src.profile != null) {
    body.profile = src.profile;
  } else if (process.env.FIRECRAWL_PROFILE_NAME) {
    body.profile = { name: process.env.FIRECRAWL_PROFILE_NAME };
    const save = process.env.FIRECRAWL_PROFILE_SAVE_CHANGES;
    if (save != null && save !== "") {
      body.profile.saveChanges = !/^(0|false|no|off)$/i.test(save);
    }
  }
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
          "Firecrawl cloud browser provider (CDP) plus scrape/search/crawl/map/parse commands",
      },
    });
  }

  // --- browser.provider ---
  if (type === "browser.launch") {
    const session = await api("POST", "/v2/browser", browserCreateBody(input.request));
    if (!session.cdpUrl) throw new Error("Firecrawl did not return a cdpUrl");
    if (!session.id) throw new Error("Firecrawl did not return a session id");
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

  // --- command.run: parse a local document (multipart upload) ---
  if (type === "firecrawl.parse") {
    const r = input.request && typeof input.request === "object" ? input.request : {};
    const filePath = r.file || r.path;
    if (!filePath) throw new Error("firecrawl.parse requires a 'file' path");
    const bytes = await fs.promises.readFile(filePath);
    const form = new FormData();
    form.append("file", new Blob([bytes]), nodePath.basename(filePath));
    // `options` must be a plain text field, not a file part, or the server's
    // multipart parser rejects it ("Unexpected field").
    if (r.options != null) {
      form.append("options", JSON.stringify(r.options));
    }
    const data = await api("POST", "/v2/parse", form);
    return ok({ data });
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
