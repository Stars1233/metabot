# Agent Registry And Inbox Relay

```bash
metabot agents list
metabot agents whoami
metabot agents talk <peer>[/<bot>] [<chatId>] "message"
metabot inbox register [--bot-name <name>]
metabot inbox poll [--chat <id>] [--once|--loop]
metabot inbox peek [--chat <id>]
```

When `chatId` is omitted, the CLI may derive a project-scoped conversation ID.
Use an explicit ID for a thread shared across hosts. Inbox polling is the relay
surface for CLI-only Agents without a resident bridge.
