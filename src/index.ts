#!/usr/bin/env node
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "./server.js";

serveStdio(buildServer);
// Report the revision the SDK actually negotiates, never a hardcoded one. This banner
// read "MCP 2026-07-28" until 2026-09-04 -- a revision @modelcontextprotocol/server@2.0.0
// does not implement (its LATEST_PROTOCOL_VERSION is 2025-11-25). A stdio probe confirmed
// the server negotiates 2025-11-25 while this line claimed otherwise.
process.stderr.write(
  `time-mcp: serving on stdio (MCP ${LATEST_PROTOCOL_VERSION} + legacy)\n`,
);
