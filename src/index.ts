#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "./server.js";

serveStdio(buildServer);
process.stderr.write("time-mcp: serving on stdio (MCP 2026-07-28 + legacy)\n");
