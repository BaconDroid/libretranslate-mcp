/**
 * Minimal HTTP client for a self-hosted LibreTranslate instance.
 *
 * LibreTranslate exposes three endpoints we care about:
 *   POST /translate  - { q, source, target, format, alternatives }
 *   POST /detect     - { q }
 *   GET  /languages  - [{ code, name, targets }]
 *
 * Every response is parsed defensively. The upstream API is a third-party
 * service whose exact payload shape varies with version and deployment flags,
 * so a shape mismatch must fail loudly (with the received body) instead of
 * silently yielding `undefined` to the caller.
 */

import { DEFAULT_LIBRETRANSLATE_URL, DEFAULT_TIMEOUT_MS } from "../constants.js";
import type {
  AlternativesResult,
  DetectResult,
  DetectedLanguage,
  LanguageEntry,
  LanguagesResult,
  LibreTranslateClientOptions,
  TranslateRequest,
  TranslateResult,
} from "../types.js";

/** Longest error excerpt we ever embed in an exception message. */
const SHAPE_PREVIEW_LIMIT = 300;

/** Truncate a string so it stays readable inside an error message. */
function truncate(text: string, limit: number = SHAPE_PREVIEW_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}... (truncated, ${text.length} chars total)`;
}

/** JSON-stringify any value, truncated, for use in diagnostics. */
function describeShape(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return truncate(value);
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return truncate(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pull `{"error": "..."}` out of a failed LibreTranslate response, if present. */
function extractErrorDetail(body: unknown): string | undefined {
  if (typeof body === "string" && body.length > 0) return truncate(body);
  if (!isRecord(body)) return undefined;
  const error = body["error"];
  if (typeof error === "string" && error.length > 0) return error;
  if (error !== undefined && error !== null) return describeShape(error);
  return undefined;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export class LibreTranslateClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;

  constructor(options: LibreTranslateClientOptions = {}) {
    const rawUrl = options.baseUrl ?? process.env["LIBRETRANSLATE_URL"] ?? DEFAULT_LIBRETRANSLATE_URL;
    // Trim trailing slashes so `${baseUrl}/translate` never double-slashes.
    this.baseUrl = rawUrl.trim().replace(/\/+$/, "");
    this.timeoutMs =
      options.timeoutMs ??
      readPositiveInt(process.env["LIBRETRANSLATE_TIMEOUT_MS"], DEFAULT_TIMEOUT_MS);
  }

  /**
   * Translate text. Rejects parameter combinations LibreTranslate does not
   * support before any network call is made.
   */
  async translate(request: TranslateRequest): Promise<TranslateResult> {
    if (request.format === "html" && request.alternatives > 0) {
      throw new Error(
        'Unsupported parameter combination: format "html" cannot be combined with alternatives > 0 ' +
          "(LibreTranslate does not return alternatives for HTML input). " +
          'Retry with format "text", or set alternatives to 0.',
      );
    }

    const body = await this.request("/translate", {
      method: "POST",
      payload: {
        q: request.q,
        source: request.source,
        target: request.target,
        format: request.format,
        alternatives: request.alternatives,
      },
    });

    const translatedText = extractTranslatedText(body);
    if (translatedText === undefined) {
      throw new Error(
        "LibreTranslate POST /translate returned a body with no recognisable translated text " +
          `(expected a bare JSON string or an object with a "translatedText" string). ` +
          `Received: ${describeShape(body)} (endpoint ${this.baseUrl}/translate)`,
      );
    }

    return {
      translatedText,
      detectedLanguage: extractDetectedLanguage(body),
      alternatives: extractAlternatives(body),
      raw: body,
    };
  }

  /** Detect the language of one or more strings. */
  async detect(q: string | string[]): Promise<DetectResult> {
    const body = await this.request("/detect", { method: "POST", payload: { q } });

    const candidates: unknown[] = Array.isArray(body) ? body : [body];
    const detections: DetectedLanguage[] = [];
    let unreadable = 0;

    for (const candidate of candidates) {
      if (isRecord(candidate)) {
        const language = candidate["language"];
        const confidence = candidate["confidence"];
        if (typeof language === "string") {
          detections.push({
            language,
            confidence: typeof confidence === "number" ? confidence : undefined,
          });
          continue;
        }
      }
      unreadable += 1;
    }

    if (detections.length === 0) {
      throw new Error(
        "LibreTranslate POST /detect returned no usable language result " +
          `(expected an array of {"language": string, "confidence": number}, or a single such object). ` +
          `Received: ${describeShape(body)} (endpoint ${this.baseUrl}/detect)`,
      );
    }

    return { detections, unreadable, raw: body };
  }

  /** List the languages this LibreTranslate instance can work with. */
  async languages(): Promise<LanguagesResult> {
    const body = await this.request("/languages", { method: "GET" });

    if (!Array.isArray(body)) {
      throw new Error(
        "LibreTranslate GET /languages returned a body that is not an array " +
          `(expected [{ "code": string, "name": string, "targets": string[] }]). ` +
          `Received: ${describeShape(body)} (endpoint ${this.baseUrl}/languages)`,
      );
    }

    const languages: LanguageEntry[] = [];
    let skipped = 0;
    for (const entry of body) {
      if (!isRecord(entry)) {
        skipped += 1;
        continue;
      }
      const code = entry["code"];
      const name = entry["name"];
      if (typeof code !== "string" || typeof name !== "string") {
        skipped += 1;
        continue;
      }
      const targets = entry["targets"];
      languages.push({
        code,
        name,
        targets: Array.isArray(targets) ? targets.filter((t): t is string => typeof t === "string") : [],
      });
    }

    if (languages.length === 0) {
      throw new Error(
        "LibreTranslate GET /languages returned no usable language entry " +
          `(entries need at least a "code" and a "name" string). Received: ${describeShape(body)} ` +
          `(endpoint ${this.baseUrl}/languages)`,
      );
    }

    return { languages, skipped, raw: body };
  }

  /**
   * Shared request path: one fetch, one JSON parse, one error-formatting rule.
   * Every non-2xx response becomes an Error carrying the upstream `error`
   * string when there is one, plus the status and the endpoint.
   */
  private async request(
    path: string,
    init: { method: "GET" | "POST"; payload?: Record<string, unknown> },
  ): Promise<unknown> {
    const endpoint = `${this.baseUrl}${path}`;
    const hasPayload = init.payload !== undefined;
    const timeoutMs = this.timeoutMs;

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: init.method,
        headers: hasPayload
          ? { Accept: "application/json", "Content-Type": "application/json" }
          : { Accept: "application/json" },
        body: hasPayload ? JSON.stringify(init.payload) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new Error(
          `LibreTranslate ${init.method} ${path} timed out after ${timeoutMs} ms ` +
            `(LIBRETRANSLATE_TIMEOUT_MS). Is the service reachable at ${this.baseUrl}?`,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `LibreTranslate ${init.method} ${path} request failed: ${message} (endpoint ${endpoint})`,
      );
    }

    const rawText = await response.text().catch(() => "");
    let parsed: unknown;
    let parseFailed = false;
    if (rawText.trim().length > 0) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parseFailed = true;
      }
    }

    if (!response.ok) {
      const detail = extractErrorDetail(parsed) ?? (rawText.trim() ? truncate(rawText) : "<empty body>");
      throw new Error(
        `LibreTranslate ${init.method} ${path} failed: HTTP ${response.status} ${response.statusText} - ${detail} ` +
          `(endpoint ${endpoint})`,
      );
    }

    if (parseFailed) {
      throw new Error(
        `LibreTranslate ${init.method} ${path} returned a non-JSON body: ${truncate(rawText)} ` +
          `(endpoint ${endpoint})`,
      );
    }

    return parsed;
  }
}

/** `translatedText` may be a bare string or an object field; anything else is a mismatch. */
function extractTranslatedText(body: unknown): string | undefined {
  if (typeof body === "string") return body;
  if (!isRecord(body)) return undefined;
  const translated = body["translatedText"];
  return typeof translated === "string" ? translated : undefined;
}

function extractDetectedLanguage(body: unknown): DetectedLanguage | undefined {
  if (!isRecord(body)) return undefined;
  const detected = body["detectedLanguage"];
  if (!isRecord(detected)) return undefined;
  const language = detected["language"];
  if (typeof language !== "string") return undefined;
  const confidence = detected["confidence"];
  return { language, confidence: typeof confidence === "number" ? confidence : undefined };
}

/**
 * LibreTranslate may return alternatives as plain strings or as objects with a
 * `text` (and optional `confidence`) field, depending on version. Both are
 * normalised; anything else is reported as present-but-unusable rather than
 * silently dropped.
 */
function extractAlternatives(body: unknown): AlternativesResult {
  const empty: AlternativesResult = { present: false, values: [], confidences: [], unusable: false };
  if (!isRecord(body)) return empty;

  const raw = body["alternatives"];
  if (raw === undefined || raw === null) return empty;
  if (!Array.isArray(raw)) return { present: true, values: [], confidences: [], unusable: true };

  const values: string[] = [];
  const confidences: (number | undefined)[] = [];
  let unusable = raw.length === 0;

  for (const item of raw) {
    if (typeof item === "string") {
      values.push(item);
      confidences.push(undefined);
      continue;
    }
    if (isRecord(item)) {
      const text = item["text"];
      const confidence = item["confidence"];
      if (typeof text === "string") {
        values.push(text);
        confidences.push(typeof confidence === "number" ? confidence : undefined);
        continue;
      }
    }
    unusable = true;
    values.push(describeShape(item));
    confidences.push(undefined);
  }

  return { present: true, values, confidences, unusable };
}
