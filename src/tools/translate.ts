import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { LibreTranslateClient } from "../services/libretranslate.js";
import type { ToolErrorResult, ToolTextResult } from "../types.js";

/** Upper bound accepted for the `alternatives` input. */
const MAX_ALTERNATIVES = 10;

function textResult(payload: unknown): ToolTextResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string): ToolErrorResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Register the `translate` tool on `server`. */
export function registerTranslateTools(server: McpServer, client: LibreTranslateClient): void {
  server.registerTool(
    "translate",
    {
      title: "Translate text",
      description:
        "Translate text using a self-hosted LibreTranslate instance (POST /translate). " +
        'Set source to "auto" to let LibreTranslate detect the input language; the detected ' +
        "language and its confidence are then reported in the result. " +
        'format "html" treats the input as HTML; LibreTranslate does not support alternatives ' +
        'for HTML input, so format "html" with alternatives > 0 is rejected before the request ' +
        'is sent. With format "text" and alternatives > 0, the other candidate translations ' +
        "returned by LibreTranslate are included when the response carries them, and an explicit " +
        "note is returned when it does not.",
      inputSchema: {
        q: z.string().min(1).describe("Text to translate."),
        source: z
          .string()
          .min(1)
          .default("auto")
          .describe('Source language code, or "auto" to let LibreTranslate detect it.'),
        target: z
          .string()
          .min(1)
          .describe("Target language code. Use the languages tool to list the codes this instance supports."),
        format: z
          .enum(["text", "html"])
          .default("text")
          .describe('Input format: "text" (default) or "html".'),
        alternatives: z
          .number()
          .int()
          .min(0)
          .max(MAX_ALTERNATIVES)
          .default(0)
          .describe(
            `Number of alternative translations to request (0-${MAX_ALTERNATIVES}). ` +
              'Only supported with format "text".',
          ),
      },
    },
    async (args) => {
      try {
        const result = await client.translate({
          q: args.q,
          source: args.source,
          target: args.target,
          format: args.format,
          alternatives: args.alternatives,
        });

        const payload: Record<string, unknown> = {
          translatedText: result.translatedText,
          source: args.source,
          target: args.target,
          format: args.format,
        };

        if (result.detectedLanguage !== undefined) {
          payload["detectedLanguage"] = result.detectedLanguage;
        } else if (args.source === "auto") {
          payload["detectedLanguage"] = null;
          payload["note"] =
            "LibreTranslate did not report a detected language for this request. " +
            "This is expected when the source language was not 'auto'.";
        }

        if (args.alternatives > 0) {
          const alternatives = result.alternatives;
          if (!alternatives.present) {
            payload["alternatives"] = {
              requested: args.alternatives,
              returned: 0,
              note:
                "LibreTranslate returned no `alternatives` field in the response, so no " +
                "alternative translations are available for this request.",
            };
          } else if (alternatives.unusable) {
            payload["alternatives"] = {
              requested: args.alternatives,
              returned: alternatives.values.length,
              note:
                "The `alternatives` field was present but not in a shape this client could read " +
                "as text; the raw entries are listed verbatim below.",
              raw: alternatives.values,
            };
          } else {
            const entry: Record<string, unknown> = {
              requested: args.alternatives,
              returned: alternatives.values.length,
              values: alternatives.values,
            };
            if (alternatives.confidences.some((c) => typeof c === "number")) {
              entry["confidences"] = alternatives.confidences;
            }
            if (alternatives.values.length === 0) {
              entry["note"] = "LibreTranslate returned an empty alternatives list for this request.";
            }
            payload["alternatives"] = entry;
          }
        }

        return textResult(payload);
      } catch (error) {
        return errorResult(messageOf(error));
      }
    },
  );
}
