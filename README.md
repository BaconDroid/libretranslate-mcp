# libretranslate-mcp

[![build](https://github.com/BaconDroid/libretranslate-mcp/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/BaconDroid/libretranslate-mcp/actions/workflows/build.yml)

An MCP server that exposes a **self-hosted LibreTranslate** instance as three
tools: `translate`, `detect`, `languages`.

It is a thin, honest wrapper over LibreTranslate's REST API. It does no
translation itself, has no glossary, no document translation, and no
translation memory.

**Deployment has not happened yet.** The open items, the commands that close
them, and the traps for the next session live in
`unraid-stack/docs/LIBRETRANSLATE-MCP-NEXT.md` — in the **private**
`BaconDroid/unraid-stack` repository, so the link below resolves only for
account holders, not for anonymous visitors.

---

## What is verified, and what is not

The badge above is the source of truth for the current CI state. This section
deliberately makes no claim about it, because such claims go stale on every
run. What follows are durable facts, none of which a CI run can change.

**Verified against pinned upstream source, and exercised end to end**

- The three response shapes this client parses were read directly out of
  LibreTranslate's own code at commit `4aca61bd` (release `v1.9.6`), and each
  one matches what the client expects:
  - `POST /translate` returns `{"translatedText": <string>}`, adding
    `detectedLanguage` as `{language, confidence}` only when `source` is
    `"auto"`, and `alternatives` — an array of **plain strings** — only when
    `alternatives > 0`. A second return in that route is a translation-cache
    hit serving the same shape, not a different one.
  - `GET /languages` returns `[{code, name, targets}]`.
  - `POST /detect` returns an array of `{language, confidence}`. The upstream
    `model2iso` helper preserves that dict and only lowercases the code.
  - Two details worth knowing: upstream filters the primary translation out of
    its own `alternatives` list, so fewer candidates can come back than were
    requested; and a **batch** `q` (an array) puts a *list* into
    `translatedText`. This client only ever sends a string, so it never reaches
    that branch.
- The HTTP transport was then **executed**, against a stub serving exactly those
  three shapes. Observed, not reasoned about:
  - `GET /health` → 200 with `authEnabled` reported truthfully;
    `POST /mcp` with no or a wrong token → 401; `GET /mcp` → 405; a body over
    `MAX_BODY_BYTES` → 413; an unknown path → 404.
  - The MCP handshake completes: `initialize` returns 200 with
    `protocolVersion 2025-06-18`, and `tools/list` on a **second** request
    returns all three tools with their schemas. That second request is the point:
    it is what a fresh server per request means in practice, and it is the
    defect `createServer()` exists to fix in the sibling repo.
  - `tools/call` on all three tools parses the contract correctly, including
    `detectedLanguage` appearing only for `source: "auto"` and the
    `requested`/`returned` accounting on `alternatives`.
  - The defensive paths fire as designed: `format: "html"` with
    `alternatives > 0` is refused before any network call, a non-2xx response
    reports the status, the upstream body and the endpoint, and a 200 whose
    shape is unrecognised fails loudly with the received payload quoted rather
    than returning `undefined`.

Two limits on that evidence, both real:

- **The upstream was a stub, not LibreTranslate.** It reproduced the contract
  confirmed in the pinned source, so it validates the client's parsing and its
  error handling, not LibreTranslate itself. The real round trip is still
  unobserved. The contract is anchored to a named commit, so if upstream changes
  it the claim is falsifiable rather than stale by assertion.
- **It first ran under Bun 1.4.2, not Node.** That run was made before the
  server had ever been executed at all, and Bun implements `node:http`,
  `node:crypto` and `fetch`, so it was meaningful — but the shipped image is
  `node:22-alpine`, and no request had been served by Node at the time.

Both runtime gaps are now closed. Two smoke tests run on Node in CI on every
push, both against `dist/index.js` — what the container actually executes — and
both against the same stub. No new dependency: `node:assert` and an exit code.

- `npm run test:smoke` — 15 assertions on the HTTP transport: the status paths,
  the MCP handshake, `tools/list` on a second request, `tools/call` on all three
  tools, and the defensive paths.
- `npm run test:smoke:stdio` — 7 assertions on the stdio transport, spoken as
  newline-delimited JSON-RPC over stdin/stdout. It also asserts the invariant
  that only makes stdio safe: a populated stdout carries JSON-RPC and nothing
  else, while the startup banner goes to stderr. That check runs last on
  purpose — before any traffic an empty stdout is correct, not a fault.

The step results are visible in the workflow; the log bodies are not readable
without repository admin access, so the passes are confirmed at step level
rather than by quoting the lines the tests printed. Both suites were also
verified to *fail* when an assertion is deliberately broken, which is the only
reason a green run means anything.

**What is still unverified: LibreTranslate itself.** The upstream in all of the
above is a stub reproducing the contract read from the pinned source. It
validates this client's parsing, its error handling and its framing, not the
real service. The contract is anchored to a named commit, so if upstream changes
it the claim is falsifiable rather than stale by assertion.

**Dependency surface**

- `package-lock.json` is committed and CI installs with `npm ci`, so the
  dependency tree is pinned and reproducible. Bumping the SDK or `zod` is now a
  deliberate, reviewable change to the lockfile rather than something that
  happens silently on the next run.
- The pinned versions were resolved once and never re-checked against the SDK's
  published type definitions by hand. The `McpServer` / `registerTool` /
  `StreamableHTTPServerTransport` calls follow the SDK's documented usage; a
  real signature mismatch would surface as a typecheck failure, not a silent
  breakage.

**Not verified — published image**

- `unraid-stack/my-libretranslate-mcp.xml` still references the placeholder
  `REPLACE_ME/libretranslate-mcp:latest`. It must be replaced with a real
  published image before that template will start; see
  `unraid-stack/docs/translation-mcp.md`.

To reproduce the CI checks locally on a machine with Node 20+:

```sh
npm ci
npm run typecheck
npm run build
```


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
