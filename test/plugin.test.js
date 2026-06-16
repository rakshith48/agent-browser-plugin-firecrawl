"use strict";

// Hermetic tests for the agent-browser plugin protocol handling.
// No network and no deps: the bin is spawned as a subprocess and, where an
// HTTP call is expected, FIRECRAWL_API_URL is pointed at a local mock server
// that records the outgoing request. Run with `npm test` (`node --test`).

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const BIN = path.join(__dirname, "..", "bin", "plugin.js");
const PROTOCOL = "agent-browser.plugin.v1";

let server;
let baseUrl;
let lastReq;

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastReq = {
        method: req.method,
        url: req.url,
        auth: req.headers["authorization"],
        body: body ? JSON.parse(body) : null,
      };
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/v2/browser") {
        res.end(
          JSON.stringify({
            success: true,
            id: "sess-123",
            cdpUrl: "wss://mock.firecrawl.dev/cdp/sess-123?token=t",
            liveViewUrl: "https://mock.firecrawl.dev/live",
          })
        );
      } else if (req.method === "DELETE" && req.url.startsWith("/v2/browser/")) {
        res.end(JSON.stringify({ success: true }));
      } else if (req.method === "POST" && req.url === "/v2/scrape") {
        res.end(JSON.stringify({ success: true, data: { markdown: "# Mock" } }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, error: "not found" }));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

// Spawn the bin with a clean env (no inherited FIRECRAWL_* unless overridden).
function run(envelope, extraEnv = {}) {
  const env = { ...process.env };
  for (const k of [
    "FIRECRAWL_API_KEY",
    "FIRECRAWL_API_URL",
    "FIRECRAWL_PROFILE_NAME",
    "FIRECRAWL_PROFILE_SAVE_CHANGES",
  ]) {
    delete env[k];
  }
  Object.assign(env, extraEnv);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], { env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => {
      let json = null;
      try {
        json = JSON.parse(out);
      } catch {
        /* leave null */
      }
      resolve({ code, out, json });
    });
    child.stdin.end(JSON.stringify(envelope));
  });
}

const env = (extra) => ({ FIRECRAWL_API_URL: baseUrl, FIRECRAWL_API_KEY: "fc-test", ...extra });

// --- protocol / offline paths (no network) ---

test("manifest returns name + all capabilities, exit 0", async () => {
  const { code, json } = await run({ protocol: PROTOCOL, type: "plugin.manifest", request: {} });
  assert.equal(code, 0);
  assert.equal(json.success, true);
  assert.equal(json.manifest.name, "firecrawl");
  assert.ok(json.manifest.capabilities.includes("browser.provider"));
  assert.ok(json.manifest.capabilities.includes("firecrawl.scrape"));
});

test("wrong protocol fails gracefully, exit 0", async () => {
  const { code, json } = await run({ protocol: "nope", type: "plugin.manifest", request: {} });
  assert.equal(code, 0);
  assert.equal(json.success, false);
  assert.match(json.error, /unsupported protocol/);
});

test("unknown request type fails", async () => {
  const { json } = await run({ protocol: PROTOCOL, type: "firecrawl.bogus", request: {} });
  assert.equal(json.success, false);
  assert.match(json.error, /unsupported request type/);
});

test("browser.launch without API key fails clearly, exit 0", async () => {
  const { code, json } = await run({ protocol: PROTOCOL, type: "browser.launch", request: {} });
  assert.equal(code, 0);
  assert.equal(json.success, false);
  assert.match(json.error, /FIRECRAWL_API_KEY/);
});

// --- browser.provider against the mock (verifies the launchOptions fix) ---

test("browser.launch reads ttl nested under launchOptions and returns cdpUrl", async () => {
  const { json } = await run(
    {
      protocol: PROTOCOL,
      type: "browser.launch",
      request: { provider: "firecrawl", session: "default", launchOptions: { ttl: 120 } },
    },
    env()
  );
  assert.equal(json.success, true);
  assert.equal(json.browser.cdpUrl, "wss://mock.firecrawl.dev/cdp/sess-123?token=t");
  assert.equal(json.browser.directPage, false);
  assert.equal(json.browser.metadata.sessionId, "sess-123");
  assert.deepEqual(json.browser.cleanup, { sessionId: "sess-123" });
  // the outgoing request body picked up the nested ttl
  assert.equal(lastReq.method, "POST");
  assert.equal(lastReq.url, "/v2/browser");
  assert.equal(lastReq.body.ttl, 120);
  assert.equal(lastReq.auth, "Bearer fc-test");
});

test("FIRECRAWL_PROFILE_NAME env maps to profile in the create body", async () => {
  await run(
    { protocol: PROTOCOL, type: "browser.launch", request: { launchOptions: {} } },
    env({ FIRECRAWL_PROFILE_NAME: "my-app", FIRECRAWL_PROFILE_SAVE_CHANGES: "false" })
  );
  assert.deepEqual(lastReq.body.profile, { name: "my-app", saveChanges: false });
});

test("explicit launch profile wins over env", async () => {
  await run(
    {
      protocol: PROTOCOL,
      type: "browser.launch",
      request: { launchOptions: { profile: { name: "explicit" } } },
    },
    env({ FIRECRAWL_PROFILE_NAME: "from-env" })
  );
  assert.deepEqual(lastReq.body.profile, { name: "explicit" });
});

test("browser.close issues DELETE for the session id", async () => {
  const { json } = await run(
    { protocol: PROTOCOL, type: "browser.close", request: { sessionId: "sess-123" } },
    env()
  );
  assert.equal(json.success, true);
  assert.equal(lastReq.method, "DELETE");
  assert.equal(lastReq.url, "/v2/browser/sess-123");
});

// --- command.run ---

test("firecrawl.scrape forwards payload and returns data", async () => {
  const { json } = await run(
    {
      protocol: PROTOCOL,
      type: "firecrawl.scrape",
      request: { url: "https://example.com", formats: ["markdown"] },
    },
    env()
  );
  assert.equal(json.success, true);
  assert.equal(json.data.data.markdown, "# Mock");
  assert.equal(lastReq.url, "/v2/scrape");
  assert.equal(lastReq.body.url, "https://example.com");
});
