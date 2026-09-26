#!/usr/bin/env node
/**
 * End-to-end smoke test for the stdio transport.
 *
 * The HTTP transport has its own test (scripts/smoke.mjs). This one covers the
 * mode that is the default when the server is spawned locally, where a single
 * stray write to stdout would corrupt the JSON-RPC framing — which is why the
 * design routes every diagnostic to stderr. That invariant is asserted here.
 *
 * Speaks newline-delimited JSON-RPC over stdin/stdout, the way an MCP client
 * does, against the COMPILED output (dist/index.js) on Node.
 *
 * It does not validate LibreTranslate: the upstream is the same stub, serving
 * the shapes read from LibreTranslate commit 4aca61bd.
 *
 *   node scripts/smoke-stdio.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "dist", "index.js");

if (!fs.existsSync(ENTRY)) {
  console.error(`smoke-stdio: ${ENTRY} is missing — run "npm run build" first`);
  process.exit(1);
}

let passed = 0;
/**
 * Server stderr, accumulated and printed on failure. Without it a red test says
 * only that something broke, which is the opposite of useful.
 */
let stderrBuffer = "";
const childStderr = () => stderrBuffer;
/**
 * `fn` is awaited. An unawaited async assertion reports success before it has
 * run, which would make the whole suite pass unconditionally.
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

/** Same stub as the HTTP test: only shapes confirmed in pinned upstream source. */
function startStub(port) {
  const LANGUAGES = [
    { code: "en", name: "English", targets: ["fr"] },
    { code: "fr", name: "French", targets: ["en"] },
  ];
  const server = createServer(async (req, res) => {
    const route = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (route === "/languages") return json(res, LANGUAGES);
    if (route === "/translate") {
      const b = await readBody(req);
      if (b.q === undefined) return json(res, { error: "q is required" }, 400);
      const result = { translatedText: "La maison est tres vieille." };
      if (b.source === "auto") result.detectedLanguage = { language: "en", confidence: 100 };
      return json(res, result);
    }
    if (route === "/detect") {
      const b = await readBody(req);
      if (typeof b.q === "string") return json(res, [{ language: "en", confidence: 100 }]);
      return json(res, { error: "q is required" }, 400);
    }
    return json(res, { error: "not found" }, 404);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

/** Buffers newline-delimited JSON-RPC messages off a stream. */
function reader(stream, onLine) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.length > 0) onLine(line);
    }
  });
}

const run = async () => {
  const stubPort = await freePort();
  const stub = await startStub(stubPort);

  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      TRANSPORT: "stdio",
      LIBRETRANSLATE_URL: `http://127.0.0.1:${stubPort}`,
      LOG_LEVEL: "debug",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const messages = [];
  const rawStdout = [];
  reader(child.stdout, (line) => {
    rawStdout.push(line);
    try {
      messages.push(JSON.parse(line));
    } catch (err) {
      // recorded verbatim; the purity check below reports it
      messages.push({ __unparseable: line, __error: err.message });
    }
  });
  child.stderr.on("data", (c) => (stderrBuffer += c.toString()));

  const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
  const waitFor = (id, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const tick = () => {
        const hit = messages.find((m) => m.id === id);
        if (hit) return resolve(hit);
        if (Date.now() > deadline) {
          return reject(
            new Error(
              `no response to id=${id} within ${timeoutMs}ms; saw ${messages.length} message(s): ${JSON.stringify(messages).slice(0, 400)}`,
            ),
          );
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  };

  const stop = async () => {
    if (!child.killed) child.kill("SIGKILL");
    await new Promise((r) => stub.close(r));
  };

  try {
    // the startup banner must appear on stderr, since stdout is the protocol
    await new Promise((r) => setTimeout(r, 600));

    console.log("protocol hygiene");
    await check("the startup banner goes to stderr, not stdout", async () => {
      assert.match(stderrBuffer, /LibreTranslate MCP Server läuft \(stdio\)/);
      assert.ok(
        !rawStdout.some((l) => l.includes("läuft")),
        "a diagnostic leaked onto stdout and would corrupt the framing",
      );
    });

    console.log("handshake");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke-stdio", version: "1.0.0" },
      },
    });
    let initialized;
    await check("initialize is answered", async () => {
      initialized = await waitFor(1);
      assert.equal(initialized.result.serverInfo.name, "libretranslate-mcp");
      assert.ok(initialized.result.protocolVersion);
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    await check("tools/list returns the three tools", async () => {
      const { result } = await waitFor(2);
      assert.deepEqual(result.tools.map((t) => t.name).sort(), ["detect", "languages", "translate"]);
    });

    console.log("upstream contract");
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "translate", arguments: { q: "The house is very old.", source: "auto", target: "fr" } },
    });
    await check("translate parses the contract over stdio", async () => {
      const { result } = await waitFor(3);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.translatedText, "La maison est tres vieille.");
      assert.deepEqual(payload.detectedLanguage, { language: "en", confidence: 100 });
    });

    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "languages", arguments: {} } });
    await check("languages parses the contract over stdio", async () => {
      const { result } = await waitFor(4);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.count, 2);
    });

    console.log("defensive paths");
    send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "translate", arguments: { q: "<p>x</p>", source: "en", target: "fr", format: "html", alternatives: 2 } },
    });
    await check("html + alternatives > 0 is refused over stdio too", async () => {
      const { result } = await waitFor(5);
      assert.match(result.content[0].text, /cannot be combined with alternatives/);
    });

    // Purity is asserted last, and deliberately so: before any traffic has
    // been sent, an empty stdout is correct, not a fault. The property worth
    // checking is that a populated stdout carries protocol and nothing else.
    await check("every stdout line is JSON-RPC and nothing else", async () => {
      assert.ok(rawStdout.length >= 4, `expected several responses, saw ${rawStdout.length}`);
      const bad = messages.filter((m) => m.__unparseable);
      assert.equal(bad.length, 0, `non-JSON on stdout: ${JSON.stringify(bad).slice(0, 300)}`);
    });

    console.log(`\nsmoke-stdio: ${passed} checks passed on ${process.version}`);
  } finally {
    await stop();
  }
};

run().then(
  () => process.exit(0),
  (err) => {
    console.error(`\nsmoke-stdio: FAILED — ${err.message}`);
    if (childStderr().trim()) {
      console.error("\n--- server stderr ---");
      console.error(childStderr().trim().split("\n").slice(-40).join("\n"));
      console.error("--- end server stderr ---");
    }
    process.exit(1);
  },
);
