/**
 * MCP server definition: three tools backed by a LibreTranslate instance.
 *
 * `createServer()` is a factory on purpose. Registering tools onto a
 * module-level singleton makes it impossible to build a second, independent
 * server instance in the same process, which a stateless HTTP transport needs
 * (one transport + one server per request). index.ts therefore calls this
 * function on every request rather than importing a shared instance. The
 * sibling languagetool-mcp-server reuses one instance across every request,
 * which is the defect this factory exists to fix.
 *
 * Each tool lives in its own module under src/tools/ and exposes a
 * register*Tools(server, client) function, mirroring registerCheckTools /
 * registerLanguageTools in that sibling repo. This file only wires them up.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { LibreTranslateClient } from "./services/libretranslate.js";
import { registerDetectTools } from "./tools/detect.js";
import { registerLanguagesTools } from "./tools/languages.js";
import { registerTranslateTools } from "./tools/translate.js";

/** Build a fresh MCP server with all three tools registered. */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const client = new LibreTranslateClient();

  registerTranslateTools(server, client);
  registerDetectTools(server, client);
  registerLanguagesTools(server, client);

  return server;
}
