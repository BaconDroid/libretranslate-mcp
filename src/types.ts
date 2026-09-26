/**
 * Shared types: the LibreTranslate client contract and the MCP tool-result
 * shapes. Kept out of the service and tool files so the two layers can depend
 * on the same declarations without importing each other.
 */

export type TranslateFormat = "text" | "html";

export interface LibreTranslateClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export interface TranslateRequest {
  q: string | string[];
  source: string;
  target: string;
  format: TranslateFormat;
  alternatives: number;
}

/** One language guess. `confidence` is absent when upstream did not report one. */
export interface DetectedLanguage {
  language: string;
  confidence: number | undefined;
}

/** Normalised view of LibreTranslate's `alternatives` field. */
export interface AlternativesResult {
  /** Whether the response actually carried an `alternatives` field. */
  present: boolean;
  /** Candidate translations, in the order returned by LibreTranslate. */
  values: string[];
  /** Per-candidate confidence, when the payload provided one. */
  confidences: (number | undefined)[];
  /** Set when the field was present but not in a shape we could read. */
  unusable: boolean;
}

export interface TranslateResult {
  translatedText: string;
  detectedLanguage: DetectedLanguage | undefined;
  alternatives: AlternativesResult;
  /** The parsed body, for callers that want to inspect anything else. */
  raw: unknown;
}

export interface DetectResult {
  /** One entry per input string, in input order. */
  detections: DetectedLanguage[];
  /** Input strings for which no `language` string could be read. */
  unreadable: number;
  raw: unknown;
}

export interface LanguageEntry {
  code: string;
  name: string;
  targets: string[];
}

export interface LanguagesResult {
  languages: LanguageEntry[];
  /** Entries that were present but missing a usable `code`/`name`. */
  skipped: number;
  raw: unknown;
}

/** Successful tool result: a single JSON text block. */
export interface ToolTextResult {
  content: { type: "text"; text: string }[];
}

/** Failed tool result, reported to the client as a tool error rather than a crash. */
export interface ToolErrorResult {
  isError: true;
  content: { type: "text"; text: string }[];
}
