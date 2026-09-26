#!/usr/bin/env node
/**
 * End-to-end smoke test for the HTTP transport.
 *
 * Runs against the COMPILED output (dist/index.js), which is what the container
 * actually executes, on the runtime the container actually uses (Node). It
 * stands up a stub upstream that serves exactly the response shapes read out of
 * LibreTranslate commit 4aca61bd, then exercises:
 *
 *   - the status paths: /health, 401, 405, 413, 404
 *   - the MCP handshake, and tools/list on a SECOND request, which is what a
 *     fresh server per request means in practice
 *   - tools/call on all three tools, against the upstream contract
 *   - the defensive paths: html+alternatives refused before any network call,
 *     a non-2xx response reported with status and body, and a 200 whose shape
 *     is unrecognised failing loudly with the payload quoted
 *
 * It does NOT validate LibreTranslate, and it does not exercise the stdio
 * transport. Both remain open; see unraid-stack/docs/LIBRETRANSLATE-MCP-NEXT.md.
 *
 * No test framework and no new dependency: node:assert plus a plain exit code,
 * so it behaves the same in CI and on a laptop.
 *
 *   node scripts/smoke.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "dist", "index.js");
const TOKEN = "smoke-token-not-a-real-secret";
const MCP_HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

if (!fs.existsSync(ENTRY)) {
  console.error(`smoke: ${ENTRY} is missing — run "npm run build" first`);
  process.exit(1);
}

let passed = 0;
/**
 * `fn` is awaited. This matters: an unawaited async assertion reports "ok"
 * before it has run, so every check would pass unconditionally and the real
 * failure would surface later as an unhandled rejection.
 */
const check = async (label, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (err) {
    console.error(`  FAIL ${label}\n       ${err.message}`);
    throw err;
  }
};

/** Ask the OS for a free port by binding one and releasing it. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });

const json = (res, payload, status = 200) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
};

/**
 * The stub upstream. Every response body below mirrors LibreTranslate commit
 * 4aca61bd: app.py L866-871 for /translate, L1145 for /detect, L535-538 for
 * /languages. Nothing here is invented.
 */
function startStub(port, { wrongShape = false } = {}) {
  const LANGUAGES = [
    { code: "en", name: "English", targets: ["fr"] },
    { code: "fr", name: "French", targets: ["en"] },
  ];
  const server = createServer(async (req, res) => {
    const route = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (route === "/languages") return json(res, LANGUAGES);
    if (route === "/translate") {
      const b = await readBody(req);
      if (wrongShape) {
        return json(res, { resultats: { texte: "Bonjour" }, hint: "champs inattendus" });
      }
      if (b.q === undefined) return json(res, { error: "q is required" }, 400);
      if (b.format === "html" && Number(b.alternatives) > 0) {
        return json(res, { error: "Invalid request: alternatives is not supported for html" }, 400);
      }
      const result = { translatedText: "La maison est tres vieille." };
      if (b.source === "auto") result.detectedLanguage = { language: "en", confidence: 100 };
      if (Number(b.alternatives) > 0) {
        // app.py L861 filter_unique(..., translated_text): the primary is excluded
        result.alternatives = ["La maison est tres ancienne.", "La maison est vieille."];
      }
      return json(res, result);
    }
    if (route === "/detect") {
      const b = await readBody(req);
      if (typeof b.q === "string") {
        return json(res, [
          { language: "en", confidence: 100 },
          { language: "fr", confidence: 12 },
        ]);
      }
      if (Array.isArray(b.q)) return json(res, b.q.map(() => ({ language: "en", confidence: 100 })));
      return json(res, { error: "q is required" }, 400);
    }
    return json(res, { error: "not found" }, 404);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

const post = (url, body, headers = MCP_HEADERS) =>
  fetch(url, { method: "POST", headers, body: JSON.stringify(body) });

const rpc = async (url, method, params, id = 1) => {
  const r = await post(url, { jsonrpc: "2.0", id, method, params });
  return { status: r.status, body: await r.json() };
};

/**
 * Calls a tool and returns its payload.
 *
 * On success the tool returns pretty-printed JSON, so the payload is parsed and
 * returned as an object. On a handled failure it returns the error message as
 * PLAIN TEXT, which is what makes the message readable in a client. So a parse
 * failure here is not a bug: the raw text is returned and the caller asserts on
 * it with a pattern.
 */
const callTool = async (url, name, args) => {
  const { body } = await rpc(url, "tools/call", { name, arguments: args });
  const result = body.result ?? body;
  const text = result.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const waitForHealth = async (url, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  let last = "no attempt";
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
      last = `health returned ${r.status}`;
    } catch (err) {
      last = err.message;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server never became healthy: ${last}`);
};

/**
 * Server stderr, accumulated across every instance spawned during the run and
 * printed on failure. Without it a red test says only that something broke,
 * which is the opposite of useful.
 */
let serverStderr = "";

function startServer(port, upstream, extraEnv = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      TRANSPORT: "http",
      PORT: String(port),
      AUTH_TOKEN: TOKEN,
      LIBRETRANSLATE_URL: upstream,
      MAX_BODY_BYTES: "4096",
      LOG_LEVEL: "error",
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (c) => (serverStderr += c.toString()));
  return { child, getStderr: () => serverStderr };
}

const run = async () => {
  const stubPort = await freePort();
  const mcpPort = await freePort();
  const stubUrl = `http://127.0.0.1:${stubPort}`;
  const mcpUrl = `http://127.0.0.1:${mcpPort}`;
  const mcp = `${mcpUrl}/mcp`;

  let stub = await startStub(stubPort);
  let srv = startServer(mcpPort, stubUrl);
  const spawned = [srv.child];
  const stop = async () => {
    for (const c of spawned) if (!c.killed) c.kill("SIGKILL");
    if (stub?.listening) await new Promise((r) => stub.close(r));
  };

  try {
    await waitForHealth(mcpUrl);

    console.log("status paths");
    await check("GET /health is 200 and reports auth enabled", async () => {
      assert.equal((await fetch(`${mcpUrl}/health`)).status, 200);
    });
    await check("POST /mcp without a token is 401", async () => {
      const r = await post(mcp, {}, { "Content-Type": "application/json" });
      assert.equal(r.status, 401);
      assert.match(r.headers.get("www-authenticate") ?? "", /Bearer/);
    });
    await check("POST /mcp with a wrong token is 401", async () => {
      const r = await post(mcp, {}, { ...MCP_HEADERS, Authorization: "Bearer wrong" });
      assert.equal(r.status, 401);
    });
    await check("GET /mcp is 405", async () => {
      const r = await fetch(mcp, { headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.equal(r.status, 405);
    });
    await check("a body over MAX_BODY_BYTES is 413", async () => {
      const r = await post(mcp, { pad: "x".repeat(9000) });
      assert.equal(r.status, 413);
    });
    await check("an unknown path is 404", async () => {
      const r = await fetch(`${mcpUrl}/nope`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.equal(r.status, 404);
    });

    console.log("mcp protocol");
    await check("initialize returns 200 and the server name", async () => {
      const { status, body } = await rpc(mcp, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke", version: "1.0.0" },
      });
      assert.equal(status, 200);
      assert.equal(body.result.serverInfo.name, "libretranslate-mcp");
      assert.ok(body.result.protocolVersion);
    });
    await check("tools/list on a SECOND request still works (fresh server per request)", async () => {
      const { status, body } = await rpc(mcp, "tools/list", {}, 2);
      assert.equal(status, 200);
      const names = body.result.tools.map((t) => t.name).sort();
      assert.deepEqual(names, ["detect", "languages", "translate"]);
    });

    console.log("upstream contract");
    await check("translate parses translatedText, detectedLanguage and alternatives", async () => {
      const r = await callTool(mcp, "translate", {
        q: "The house is very old.",
        source: "auto",
        target: "fr",
        format: "text",
        alternatives: 2,
      });
      assert.equal(r.translatedText, "La maison est tres vieille.");
      assert.deepEqual(r.detectedLanguage, { language: "en", confidence: 100 });
      assert.equal(r.alternatives.requested, 2);
      assert.equal(r.alternatives.returned, 2);
      assert.ok(Array.isArray(r.alternatives.values));
    });
    await check("translate omits detectedLanguage when source is not auto", async () => {
      const r = await callTool(mcp, "translate", { q: "The house is very old.", source: "en", target: "fr" });
      assert.equal(r.detectedLanguage, undefined);
    });
    await check("detect parses the array of language/confidence", async () => {
      const r = await callTool(mcp, "detect", { q: "The house is very old." });
      assert.equal(r.inputCount, 1);
      assert.equal(r.detections[0].language, "en");
    });
    await check("languages parses the array of code/name/targets", async () => {
      const r = await callTool(mcp, "languages", {});
      assert.equal(r.count, 2);
      assert.deepEqual(r.languages[0], { code: "en", name: "English", targets: ["fr"] });
    });

    console.log("defensive paths");
    await check("html + alternatives > 0 is refused before any network call", async () => {
      const r = await callTool(mcp, "translate", {
        q: "<p>x</p>",
        source: "en",
        target: "fr",
        format: "html",
        alternatives: 2,
      });
      assert.match(r, /cannot be combined with alternatives/);
    });

    // a 200 whose shape the client does not recognise
    await new Promise((r) => stub.close(r));
    stub = await startStub(stubPort, { wrongShape: true });
    await check("an unrecognised 200 shape fails loudly with the payload quoted", async () => {
      const r = await callTool(mcp, "translate", { q: "x", source: "en", target: "fr" });
      assert.match(r, /no recognisable translated text/);
      assert.match(r, /resultats/, "the received payload must be quoted back");
    });
    await new Promise((r) => stub.close(r));
    stub = await startStub(stubPort);

    // an upstream that is simply not there
    srv.child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    srv = startServer(mcpPort, "http://127.0.0.1:1", {});
    spawned.push(srv.child);
    await waitForHealth(mcpUrl);
    await check("an unreachable upstream reports the endpoint", async () => {
      const r = await callTool(mcp, "translate", { q: "x", source: "en", target: "fr" });
      assert.match(r, /endpoint/);
    });

    console.log(`\nsmoke: ${passed} checks passed on ${process.version}`);
  } finally {
    await stop();
  }
};

run().then(
  () => process.exit(0),
  (err) => {
    console.error(`\nsmoke: FAILED — ${err.message}`);
    if (serverStderr.trim()) {
      console.error("\n--- server stderr ---");
      console.error(serverStderr.trim().split("\n").slice(-40).join("\n"));
      console.error("--- end server stderr ---");
    }
    process.exit(1);
  },
);
