import { describe, it, expect } from "vitest";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildServer } from "../src/server.js";

const PROTOCOL_VERSION = "2026-07-28";

function mcpRequest(body: Record<string, unknown>, options?: { toolName?: string }): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "mcp-protocol-version": PROTOCOL_VERSION,
    "mcp-method": String(body.method),
  };
  if (options?.toolName) headers["mcp-name"] = options.toolName;

  return new Request("http://test.local/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("MCP 2026-07-28 protocol", () => {
  const handler = createMcpHandler(buildServer);

  it("implements server/discover with supported versions and tools capability", async () => {
    const res = await handler.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": { name: "vitest", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      result: {
        supportedVersions: string[];
        capabilities: { tools?: Record<string, unknown> };
        _meta?: Record<string, Record<string, unknown>>;
      };
    };
    expect(json.result.supportedVersions).toContain(PROTOCOL_VERSION);
    expect(json.result.capabilities.tools).toBeDefined();
    expect(json.result._meta?.["io.modelcontextprotocol/serverInfo"]).toMatchObject({
      name: "time-mcp",
    });
  });

  it("lists all 14 tools over the modern protocol", async () => {
    const res = await handler.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": { name: "vitest", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(json.result.tools).toHaveLength(14);
    expect(json.result.tools.map((t) => t.name).sort()).toEqual([
      "alarm_cancel", "alarm_check", "alarm_list", "alarm_set",
      "convert_time", "get_current_time",
      "stopwatch_check", "stopwatch_list", "stopwatch_start", "stopwatch_stop",
      "timer_cancel", "timer_check", "timer_list", "timer_start",
    ]);
  });

  it("calls get_current_time over the modern protocol", async () => {
    const res = await handler.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "get_current_time",
            arguments: { timezone: "UTC" },
            _meta: {
              "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
              "io.modelcontextprotocol/clientInfo": { name: "vitest", version: "1.0.0" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        },
        { toolName: "get_current_time" },
      ),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { result: { content: { type: string; text: string }[] } };
    const payload = JSON.parse(json.result.content[0].text) as { timezone: string };
    expect(payload.timezone).toBe("UTC");
  });
});
