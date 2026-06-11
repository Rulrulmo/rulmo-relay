# company-relay Claude Code plugin

Zero-config Company Relay peer for Claude Code.

Install from GitHub marketplace:

```text
/plugin marketplace add rulmo/company-relay
/plugin install company-relay
```

Then restart Claude Code with the channel flag so incoming relay tasks can be injected into the live session:

```bash
claude --dangerously-load-development-channels server:company-relay
```

No Bun install, npm install, or relay env file is required. Advanced overrides are still supported via `RELAY_BASE_URL`, `RELAY_WORKSPACE`, `RELAY_TOKEN`, `RELAY_PEER_NAME`, `RELAY_PEER_GROUP`, and related variables.
