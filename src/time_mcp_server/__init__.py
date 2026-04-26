"""time-mcp — FastMCP server providing time, timezone, timer, stopwatch, and alarm tools.

Submodules import explicitly (``from time_mcp_server.server import ...``) to keep
``import time_mcp_server`` itself cheap — important for the notify_hook script
which fires on every UserPromptSubmit.
"""
