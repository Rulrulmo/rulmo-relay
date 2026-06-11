---
name: company-relay-peer
description: Use when operating as a Company Relay peer, checking relay status, naming this peer, listing peers, sending peer-to-peer messages, or completing relay tasks.
---

# Company Relay Peer

You are connected to the Company Relay broker through the `company-relay` MCP server.

Useful MCP tools:

- `relay_status` — show this peer's id, workspace, group, alias, machine, and broker URL.
- `set_peer_name` — set a human-friendly alias; prefer short stable aliases like `RC`, `RAG`, `SQ`.
- `join_group` / `change_group` / `set_peer_group` — join the appropriate relay group.
- `list_peers` — list active peers in the same group.
- `send_to_peer_name` — send work to another peer by summary, alias, or `machine:alias` address.
- `check_messages` — manually poll pending messages if a channel notification did not appear.
- `complete_task` — complete a relay task with a concise summary.

When a relay task arrives, answer it in the current Claude Code session context. If the task asks for changes, inspect local files directly. After finishing, call `complete_task` with a concise result and any important artifacts.
