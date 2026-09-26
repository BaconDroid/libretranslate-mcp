import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { LibreTranslateClient } from "../services/libretranslate.js";
import type { ToolErrorResult, ToolTextResult } from "../types.js";

function textResult(payload: unknown): ToolTextResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string): ToolErrorResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Register the `detect` tool on `server`. */
export function registerDetectTools(server: McpServer, client: LibreTranslateClient): void {
  server.registerTool(
    "detect",
    {
      title: "Detect language",
      description:
        "Detect the language of one or more strings using a self-hosted LibreTranslate " +
        "instance (POST /detect). Returns one detection per input string, in input order, with " +
        "the confidence LibreTranslate reported when it provided one.",
      inputSchema: {
        q: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(20)])
          .describe("A single string, or an array of up to 20 strings, to detect."),
      },
    },
    async (args) => {
      try {
        const result = await client.detect(args.q);
        const payload: Record<string, unknown> = {
          inputCount: Array.isArray(args.q) ? args.q.length : 1,
          detections: result.detections,
        };
        if (result.unreadable > 0) {
          payload["note"] =
            `${result.unreadable} of the returned detection entries did not contain a readable ` +
            "language string and were skipped.";
        }
        return textResult(payload);
      } catch (error) {
        return errorResult(messageOf(error));
      }
    },
  );
}
