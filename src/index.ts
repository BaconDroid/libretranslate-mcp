#!/usr/bin/env node
/**
 * Entry point: both MCP transports and the TRANSPORT switch, in one file.
 *
 *   TRANSPORT=stdio (default) - StdioServerTransport on stdin/stdout
 *   TRANSPORT=http           - node:http server exposing
 *                                GET  /health - liveness probe, no auth, never
 *                                              touches LibreTranslate
 *                                POST /mcp    - MCP Streamable HTTP, bearer-authenticated
 *
 * The HTTP transport is stateless: `sessionIdGenerator: undefined` +
 * `enableJsonResponse: true` means no session id is issued and each POST is
 * answered with a plain JSON body. That requires a fresh transport AND a fresh
 * McpServer per request, which is why handleMcp calls `createServer()` instead
 * of sharing one instance. The server definition itself lives in server.ts,
 * reached through the tools/* register functions; only the HTTP plumbing is here.
 *
 * Every diagnostic goes to stderr, without exception: with the stdio transport
 * stdout carries the JSON-RPC framing, and any stray write there corrupts the
 * protocol.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { DEFAULT_HTTP_PORT, DEFAULT_MAX_BODY_BYTES, SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { createServer } from "./server.js";

// --- HTTP transport layer ---------------------------------------------------

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Every log line goes to stderr: stdout is the stdio JSON-RPC channel. */
function currentLogLevel(): LogLevel {
  const raw = (process.env["LOG_LEVEL"] ?? "info").trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(raw) ? (raw as LogLevel) : "info";
}

function log(level: LogLevel, message: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLogLevel()]) return;
  process.stderr.write(`[${SERVER_NAME}] ${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`);
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
    ...headers,
  });
  res.end(body);
}

/**
 * Constant-time bearer token comparison.
 * Length is checked first: timingSafeEqual throws on buffers of unequal length.
 */
function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return false;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  if (match === null) return false;

  const provided = Buffer.from(match[1] ?? "", "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

type BodyResult =
  | { status: "ok"; value: unknown }
  | { status: "too_large" }
  | { status: "invalid"; message: string }
  | { status: "aborted" };

/**
 * Read and JSON-parse the request body, refusing anything over `maxBytes`.
 * The cap is enforced *while* reading (and from Content-Length up front) so an
 * oversized body is never buffered, rather than accumulating chunks and
 * checking the total afterwards.
 */
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<BodyResult> {
  return new Promise<BodyResult>((resolve) => {
    let settled = false;
    const finish = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const declared = Number(req.headers["content-length"] ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      finish({ status: "too_large" });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        // Stop reading immediately: the rest of the body is never buffered.
        req.pause();
        finish({ status: "too_large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim().length === 0) {
        finish({ status: "invalid", message: "Empty request body: expected a JSON-RPC message." });
        return;
      }
      try {
        finish({ status: "ok", value: JSON.parse(raw) });
      } catch (error) {
        finish({
          status: "invalid",
          message: `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });
    req.on("aborted", () => finish({ status: "aborted" }));
    req.on("error", (error: Error) => {
      log("debug", `request stream error: ${error.message}`);
      finish({ status: "aborted" });
    });
  });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, authToken: string, maxBodyBytes: number): Promise<void> {
  if (authToken.length > 0 && !isAuthorized(req, authToken)) {
    sendJson(
      res,
      401,
      { error: "Unauthorized: a valid `Authorization: Bearer <token>` header is required." },
      { "WWW-Authenticate": `Bearer realm="${SERVER_NAME}"` },
    );
    return;
  }

  const body = await readJsonBody(req, maxBodyBytes);

  if (body.status === "too_large") {
    sendJson(res, 413, { error: `Request body exceeds the ${maxBodyBytes} byte limit (MAX_BODY_BYTES).` });
    // Close the connection so the client cannot keep streaming a body we stopped reading.
    res.on("finish", () => req.destroy());
    return;
  }
  if (body.status === "invalid") {
    sendJson(res, 400, { error: body.message });
    return;
  }
  if (body.status === "aborted") {
    log("debug", "client aborted the request before the body was complete");
    return;
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close().catch((error: unknown) => {
      log("debug", `transport close failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, body.value);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, authToken: string, maxBodyBytes: number): Promise<void> {
  const path = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;

  if (req.method === "GET" && path === "/health") {
    // Intentionally unauthenticated and intentionally cheap: it reports this
    // process only, it does not probe LibreTranslate, so a slow upstream does
    // not make the container look dead to Docker or to a load balancer.
    sendJson(res, 200, {
      status: "ok",
      service: SERVER_NAME,
      version: SERVER_VERSION,
      transport: "http",
      authEnabled: authToken.length > 0,
      libretranslateUrl: process.env["LIBRETRANSLATE_URL"] ?? "http://localhost:5000",
      maxBodyBytes,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (path === "/mcp") {
    if (req.method !== "POST") {
      sendJson(
        res,
        405,
        { error: `Method ${req.method ?? "unknown"} not allowed on /mcp. This server is stateless: use POST.` },
        { Allow: "POST" },
      );
      return;
    }
    await handleMcp(req, res, authToken, maxBodyBytes);
    return;
  }

  sendJson(res, 404, { error: `Unknown path: ${path}. Available: GET /health, POST /mcp.` });
}

// --- Transports and switch --------------------------------------------------

async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("LibreTranslate MCP Server läuft (stdio)");
}

/** Start the HTTP transport. Resolves once the server is listening. */
async function runHttp(): Promise<Server> {
  const port = readPositiveInt(process.env["PORT"], DEFAULT_HTTP_PORT);
  const maxBodyBytes = readPositiveInt(process.env["MAX_BODY_BYTES"], DEFAULT_MAX_BODY_BYTES);
  const authToken = (process.env["AUTH_TOKEN"] ?? "").trim();

  if (authToken.length === 0) {
    log(
      "warn",
      "AUTH_TOKEN is not set: POST /mcp is served WITHOUT authentication. " +
        "Anyone who can reach this port can use the translation tools. Set AUTH_TOKEN before exposing the port.",
    );
  }

  const server = createHttpServer((req, res) => {
    handleRequest(req, res, authToken, maxBodyBytes).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log("error", `unhandled request error: ${message}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: `Internal server error: ${message}` });
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  log(
    "info",
    `listening on 0.0.0.0:${port} (auth ${authToken.length > 0 ? "enabled" : "DISABLED"}, ` +
      `max body ${maxBodyBytes} bytes, LibreTranslate ${process.env["LIBRETRANSLATE_URL"] ?? "http://localhost:5000"})`,
  );

  return server;
}

const transport = (process.env.TRANSPORT ?? "stdio").trim().toLowerCase();

if (transport === "http") {
  runHttp().catch((error: unknown) => {
    console.error("Server-Fehler:", error);
    process.exit(1);
  });
} else {
  runStdio().catch((error: unknown) => {
    console.error("Server-Fehler:", error);
    process.exit(1);
  });
}
