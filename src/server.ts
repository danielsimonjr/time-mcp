import { McpServer, fromJsonSchema, type JsonSchemaType } from "@modelcontextprotocol/server";
import { HANDLERS, TOOLS } from "./tools.js";
import { PKG_VERSION } from "./version.js";

/** Build a fresh MCP server instance with all time-mcp tools registered. */
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "time-mcp", version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  for (const tool of TOOLS) {
    const handler = HANDLERS[tool.name];
    const inputSchema = fromJsonSchema(tool.inputSchema as JsonSchemaType);

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        annotations: tool.annotations,
        inputSchema,
      },
      async (args) => {
        try {
          const text = await handler(args ?? {});
          return { content: [{ type: "text" as const, text }] };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`time-mcp: handler '${tool.name}' threw: ${msg}\n`);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ status: "error", error: msg }) }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}
