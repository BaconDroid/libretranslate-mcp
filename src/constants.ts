/**
 * Shared constants.
 *
 * Anything used by more than one module lives here so the defaults have exactly
 * one definition. Values that belong to a single tool (e.g. the alternatives
 * upper bound) stay in that tool's file.
 */

export const SERVER_NAME = "libretranslate-mcp";
export const SERVER_VERSION = "0.1.0";

/** Upstream LibreTranslate, used when LIBRETRANSLATE_URL is unset. */
export const DEFAULT_LIBRETRANSLATE_URL = "http://localhost:5000";

/** Per-request upstream timeout, used when LIBRETRANSLATE_TIMEOUT_MS is unset. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Listen port for the HTTP transport, used when PORT is unset. */
export const DEFAULT_HTTP_PORT = 8787;

/** Request body cap for POST /mcp, used when MAX_BODY_BYTES is unset. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
