# rulmo-relay Claude Code plugin

Rulmo Relay live peer for Claude Code.

Install from GitHub marketplace:

```text
/plugin marketplace add rulmo/rulmo-relay
/plugin install rulmo-relay
```

Token is intentionally **not** embedded in the plugin. On the first Claude Code launch, the MCP wrapper will ask once:

```text
Rulmo Relay token:
```

It saves the token locally to `~/.config/rulmo-relay/config.json` with mode `600`.

If the TTY prompt is unavailable, set it manually once:

```bash
mkdir -p ~/.config/rulmo-relay
printf '%s' 'YOUR_TOKEN' > ~/.config/rulmo-relay/token
chmod 600 ~/.config/rulmo-relay/token
```

Then start Claude Code with the channel flag:

```bash
claude --dangerously-load-development-channels server:rulmo-relay
```

No Bun install, npm install, or relay env file is required. Optional overrides: `RULMO_RELAY_TOKEN`, `RELAY_TOKEN`, `RELAY_BASE_URL`, `RELAY_WORKSPACE`, `RELAY_PEER_NAME`, `RELAY_PEER_GROUP`.
