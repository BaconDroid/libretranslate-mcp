# libretranslate-mcp

An MCP server that exposes a **self-hosted LibreTranslate** instance as three
tools: `translate`, `detect`, `languages`.

It is a thin, honest wrapper over LibreTranslate's REST API. It does no
translation itself, has no glossary, no document translation, and no
translation memory.

---

## Read this first: this code has never been compiled

The machine this project was written on has **no Node.js, no npm, and no
Docker**. Not a single command in this repository has been run:

- `npm install` — never executed
- `npm run build` / `tsc` — never executed, so there is **no** typecheck, **no**
  compile result, and **no** evidence that the TypeScript is even syntactically
  or type-correct
- `npm start` — never executed, so the server has never started and neither
  transport has been observed working
- the client has **never been pointed at a real LibreTranslate instance**, so
  the response shapes it parses are implemented from LibreTranslate's `app.py`
  source reading, not from observed traffic

Do not treat this repository as a passing build. It is unverified source code.
The first thing to do on a machine with Node 20+ is:

```sh
npm install
npm run typecheck     # expect to fix real errors on the first run
npm run build
```

If those pass, then — and only then — the Docker image in the sibling
Unraid repository is worth building.

**Also unverified:** the exact `@modelcontextprotocol/sdk` API surface this
code targets. The `McpServer` / `registerTool` / `StreamableHTTPServerTransport`
calls follow the SDK's documented usage, but `package.json` pins a caret range
(`^1.12.0`) that was never resolved against a registry, so the installed version
may differ from the one the code was written against.

---

## Requirements

- Node.js >= 20 (native `fetch`, `AbortSignal.timeout`, `timingSafeEqual` from
  `node:crypto`)
- A reachable LibreTranslate instance
- A LibreTranslate instance that has the language pairs you intend to use
  loaded — see "Which languages are available" below

## Install and build

```sh
npm install
npm run build          # tsc -p tsconfig.json
```

## Run

```sh
# stdio (default) — for local MCP clients that spawn the server
node dist/index.js

# http — for a container
TRANSPORT=http PORT=8787 AUTH_TOKEN=$(openssl rand -hex 32) node dist/index.js
```

## Environment variables

| Variable | Default | Applies to | Meaning |
|---|---|---|---|
| `TRANSPORT` | `stdio` | both | `stdio` or `http`. |
| `LIBRETRANSLATE_URL` | `http://localhost:5000` | both | Base URL of LibreTranslate. No trailing slash. |
| `LIBRETRANSLATE_TIMEOUT_MS` | `60000` | both | Per-request timeout, via `AbortSignal.timeout`. |
| `PORT` | `8787` | http | Listen port. |
| `AUTH_TOKEN` | *(empty)* | http | Bearer token required on `POST /mcp`. **Empty means no authentication** — a warning is printed to stderr. |
| `MAX_BODY_BYTES` | `1048576` | http | Request body cap; enforced while reading, `413` on exceed. |
| `LOG_LEVEL` | `info` | both | `debug` / `info` / `warn` / `error`. |

All logs go to **stderr**, always. stdout carries the stdio JSON-RPC framing and
any stray write there corrupts the protocol.

## HTTP endpoints

| Route | Auth | Notes |
|---|---|---|
| `GET /health` | none | Liveness. Never contacts LibreTranslate, so a slow upstream does not make the container look dead. |
| `POST /mcp` | bearer, when `AUTH_TOKEN` is set | Stateless Streamable HTTP. `GET`/`DELETE` on this path return `405`. |

`/health` is unauthenticated by design: a liveness probe that fails without a
token is a liveness probe nobody runs. It exposes no secrets — service name,
version, transport mode, whether auth is on, the upstream URL, and the body cap.

Clients of `POST /mcp` must send `Accept: application/json, text/event-stream`,
which is what the MCP Streamable HTTP transport specifies. That is why
`curl` alone is a poor smoke test; use the MCP inspector (see
`../unraid-stack/docs/translation-mcp.md`).

## Tools

### `translate`

| Input | Type | Default | Notes |
|---|---|---|---|
| `q` | string | — | required, non-empty |
| `source` | string | `"auto"` | `"auto"` asks LibreTranslate to detect |
| `target` | string | — | required |
| `format` | `"text"` \| `"html"` | `"text"` | |
| `alternatives` | integer 0–10 | `0` | rejected with `format: "html"` |

Returns `translatedText`, plus `detectedLanguage` when the upstream response
carries one. With `alternatives > 0`, the candidates are included when the
response has them; when the field is absent, the result says so explicitly
instead of returning an empty list that looks like "no alternatives existed".

`format: "html"` with `alternatives > 0` is refused **before** any network
call: LibreTranslate does not return alternatives for HTML input, and sending
it produces a confusing upstream error instead of a clear one.

### `detect`

| Input | Type | Notes |
|---|---|---|
| `q` | string or string[] (1–20) | one detection per input, in order |

### `languages`

No input. Lists what *this instance* can do: `code`, `name`, and `targets` per
language. Use it to pick valid `source`/`target` values — a language absent
here cannot be used.

## Which languages are available

This client does not know. LibreTranslate only loads the language models the
deployment asks for (`LT_LOAD_ONLY` on the official container). A `target`
value that is not loaded produces an upstream `400`, which is surfaced verbatim
in the tool error. Call `languages` to see reality.

## Design notes

- **Defensive response parsing.** `/translate` accepts either a bare JSON
  string or an object with a `translatedText` string. Anything else throws an
  `Error` containing the received shape (JSON-stringified, truncated to ~300
  chars) and the endpoint, so a payload change is diagnosable from the log
  instead of surfacing as a silent `undefined`. The same posture applies to
  `/detect` (array or single object) and `/languages` (array of objects).
- **Non-2xx responses** always carry the status, the endpoint, and the upstream
  `{"error": "..."}` body when there is one.
- **`createServer()` is a factory, not a singleton.** Registering tools on a
  module-level server instance makes it impossible to build a second one in the
  same process, which the stateless HTTP transport needs (one transport + one
  server per request). See `src/server.ts`.
- **Body cap before buffering.** The `Content-Length` header is checked up
  front, and the running total is checked on every chunk; on exceed the
  response is `413` and the request stream is destroyed. The body is never
  accumulated in full and measured afterwards.
- **Token comparison is constant-time.** `crypto.timingSafeEqual`, with a
  length check first because that function throws on unequal buffer lengths.

## Project layout

```
src/
  index.ts                     entry point, TRANSPORT switch, HTTP transport
                               (auth, body cap, per-request transport)
  server.ts                    createServer() factory
  constants.ts                 shared constants
  types.ts                     shared types
  services/
    libretranslate.ts          HTTP client + defensive response parsing
  tools/
    translate.ts               registerTranslateTools
    detect.ts                  registerDetectTools
    languages.ts               registerLanguagesTools
tsconfig.json
Dockerfile
entrypoint-mcp.sh
.env.example
.github/workflows/build.yml
```

## License

MIT
