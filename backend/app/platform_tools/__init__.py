"""What the platform agent can do, exposed to it over MCP.

The agent runs in its own container and reaches the platform only through the
tools in this package, as the user who asked it (see `tokens`). Everything a
tool does goes through the same checks and the same write path the browser's
own requests do, so the agent can never reach further than its user could by
hand -- and every change it makes arrives in that user's open panes the way a
change from another tab does.

- `tokens` -- the short-lived per-turn credential and who it stands for.
- `store` -- reading and changing a live session from the server.
- `panes` -- the pane kinds the agent knows: their inputs, and how to run them.
- `server` -- the MCP server itself, mounted at /mcp.
"""
