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
const fs = require("node:fs");
const os = require("node:os");

const BIN = path.join(__dirname, "..", "bin", "plugin.js");
const PROTOCOL = "agent-browser.plugin.v1";

// Mirror the plugin's per-OS credential dir so we can plant a fake credentials.json.
function cliConfigDirFor(home) {
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "firecrawl-cli");
    case "win32":
      return path.join(home, "AppData", "Roaming", "firecrawl-cli");
    default:
      return path.join(home, ".config", "firecrawl-cli");
  }
}

let server;
let baseUrl;
let lastReq;
let emptyHome; // HOME with no stored creds
let credsHome; // HOME containing a firecrawl-cli credentials.json

before(async () => {
  // Isolated HOMEs so tests never read the dev machine's real ~/.../credentials.json
  emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "ab-empty-"));
  credsHome = fs.mkdtempSync(path.join(os.tmpdir(), "ab-creds-"));
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const contentType = req.headers["content-type"] || "";
      let parsed = null;
      if (contentType.includes("application/json") && body) {
        try {
          parsed = JSON.parse(body);
        } catch {
          /* leave null */
        }
      }
      lastReq = {
        method: req.method,
        url: req.url,
        auth: req.headers["authorization"],
        contentType,
        rawBody: body,
        body: parsed,
      };
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/v2/parse") {
        res.end(JSON.stringify({ success: true, data: { markdown: "# Parsed" } }));
      } else if (req.method === "POST" && req.url === "/v2/browser") {
        // ttl 999 simulates a malformed response (cdpUrl but no id)
        const noId = lastReq.body && lastReq.body.ttl === 999;
        res.end(
          JSON.stringify({
            success: true,
            ...(noId ? {} : { id: "sess-123" }),
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

  // Plant a CLI credentials.json (apiUrl -> mock) in credsHome.
  const dir = cliConfigDirFor(credsHome);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "credentials.json"),
    JSON.stringify({ apiKey: "fc-stored", apiUrl: baseUrl })
  );
});

after(() => {
  server.close();
  fs.rmSync(emptyHome, { recursive: true, force: true });
  fs.rmSync(credsHome, { recursive: true, force: true });
});

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
  // Default to a creds-free HOME; a test can override via extraEnv.HOME.
  env.HOME = emptyHome;
  env.USERPROFILE = emptyHome;
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

test("browser.launch fails if Firecrawl returns no session id", async () => {
  const { json } = await run(
    { protocol: PROTOCOL, type: "browser.launch", request: { launchOptions: { ttl: 999 } } },
    env()
  );
  assert.equal(json.success, false);
  assert.match(json.error, /session id/);
});

// --- credential resolution (env -> CLI credentials.json -> error) ---

test("falls back to firecrawl-cli credentials.json when no env key", async () => {
  // no FIRECRAWL_API_KEY/URL; HOME points at the planted credentials.json
  const { json } = await run(
    { protocol: PROTOCOL, type: "browser.launch", request: { launchOptions: {} } },
    { HOME: credsHome, USERPROFILE: credsHome }
  );
  assert.equal(json.success, true);
  assert.equal(lastReq.auth, "Bearer fc-stored"); // key came from the file
});

test("env FIRECRAWL_API_KEY overrides stored CLI credentials", async () => {
  const { json } = await run(
    { protocol: PROTOCOL, type: "browser.launch", request: { launchOptions: {} } },
    { HOME: credsHome, USERPROFILE: credsHome, FIRECRAWL_API_KEY: "fc-env", FIRECRAWL_API_URL: baseUrl }
  );
  assert.equal(json.success, true);
  assert.equal(lastReq.auth, "Bearer fc-env"); // env wins over the file
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

test("firecrawl.parse uploads a local file as multipart with options", async () => {
  const file = path.join(emptyHome, "doc.html");
  fs.writeFileSync(file, "<h1>HELLO_PARSE</h1>");
  const { json } = await run(
    {
      protocol: PROTOCOL,
      type: "firecrawl.parse",
      request: { file, options: { formats: ["markdown"] } },
    },
    env()
  );
  assert.equal(json.success, true);
  assert.equal(json.data.data.markdown, "# Parsed");
  assert.equal(lastReq.url, "/v2/parse");
  assert.match(lastReq.contentType, /multipart\/form-data/);
  // the file bytes and options rode along in the multipart body
  assert.match(lastReq.rawBody, /HELLO_PARSE/);
  assert.match(lastReq.rawBody, /markdown/);
});

test("firecrawl.parse without a file path fails clearly", async () => {
  const { json } = await run(
    { protocol: PROTOCOL, type: "firecrawl.parse", request: { options: {} } },
    env()
  );
  assert.equal(json.success, false);
  assert.match(json.error, /requires a 'file'/);
});
