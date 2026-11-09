import { McpServer } from "@modelcontextprotocol/server";
import type { Actor, PublicApiDeps } from "../public-api/index.js";
import { registerPublicApiTools } from "./tools.js";

/** A fresh MCP server, with the record tools its caller's token allows. */
export function createAnyGridMcpServer(
  deps: PublicApiDeps,
  actor: Actor,
): McpServer {
  const server = new McpServer(
    { name: "anygriddb", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerPublicApiTools(server, deps, actor);
  return server;
}
