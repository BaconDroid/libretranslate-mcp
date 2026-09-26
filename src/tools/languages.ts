import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { LibreTranslateClient } from "../services/libretranslate.js";

function textResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Register the `languages` tool on `server`. */
export function registerLanguagesTools(server: McpServer, client: LibreTranslateClient): void {
  server.registerTool(
    "languages",
    {
      title: "List supported languages",
      description:
        "List the languages a self-hosted LibreTranslate instance can work with " +
        "(GET /languages). Each entry has a code, a name, and the list of target codes that " +
        "language can be translated into on this instance. The list reflects the instance " +
        "configuration, not this client: a language missing here cannot be used as a target.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await client.languages();
        const payload: Record<string, unknown> = {
          count: result.languages.length,
          languages: result.languages,
        };
        if (result.skipped > 0) {
          payload["note"] =
            `${result.skipped} entries were skipped because they did not carry a readable ` +
            "code and name.";
        }
        return textResult(payload);
      } catch (error) {
        return errorResult(messageOf(error));
      }
    },
  );
}
