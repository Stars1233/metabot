# Troubleshooting

Start with the supported runtime and the built-in diagnostics:

```bash
node --version                 # must be >= 22.19
metabot status
metabot doctor
metabot health
```

## Core Console does not open

The Personal Edition console is `http://localhost:9200`; port `9100` is the
Bridge API, not a second Web UI.

```bash
metabot status
curl -fsS http://localhost:9200/health
metabot restart
```

Use the token stored at `~/.metabot-core/token`. The file should be readable
only by your user:

```bash
stat -c '%a %n' ~/.metabot-core/token   # expected: 600
```

Do not paste the token into an issue or log. For a remote console, put Core
behind your own authenticated HTTPS reverse proxy or private network.

## Codex does not start

Authenticate in a standalone terminal, then restart MetaBot:

```bash
codex login
codex --version
metabot restart
```

MetaBot uses `codex exec --json` and resume. Check `metabot logs` for the exact
CLI exit reason and confirm the Bot workspace exists and is writable.

## Kimi Code does not connect

Kimi support requires Kimi Code 0.27 or newer and its official loopback Server
API:

```bash
npm install -g @moonshot-ai/kimi-code@latest
kimi login
kimi --version
metabot restart
```

Legacy Python `kimi-cli --wire` configuration is not compatible with this
adapter. Keep the Kimi server on loopback; MetaBot rejects non-loopback server
URLs by default.

## Feishu/Lark receives no messages

1. Select **persistent connection** rather than an HTTP callback.
2. Start MetaBot before saving the event subscription.
3. Subscribe to `im.message.receive_v1`.
4. Publish and enable the app version.
5. Confirm the configured App ID and secret belong to the same app.

See [Feishu App Setup](getting-started/feishu-app-setup.md).

## A group bot does not reply

Groups default to exact `@Bot` routing. Mention the intended bot, then inspect
the current reply mode:

```text
@Bot /group-reply status
@Bot /group-reply mention
@Bot /group-reply all
```

Only the group owner can change the mode. The app needs `im:chat:readonly` to
verify ownership; lookup failures are fail-closed and do not change settings.

## Update failed

Package updates verify both `SHA256SUMS` and the Personal Edition manifest
before replacing code:

```bash
metabot update
metabot doctor
```

For a reproducible rollback, install a known release explicitly:

```bash
metabot update --package --version 1.3.0
```

Updates preserve `.env`, `bots.json`, `data/`, `logs/`, `~/.metabot/`, and
`~/.metabot-core/`. If the checksum or manifest does not match, do not bypass
the check; retry from the official GitHub Release.

## Claude Code compatibility

Claude is optional for existing workspaces. Run `claude login` in a standalone
terminal and select `"engine": "claude"` for that bot. Codex and Kimi Code are
the primary Personal Edition engines.

If the issue remains, include the MetaBot version, operating system, selected
engine, `metabot doctor` output with secrets removed, and the smallest relevant
log excerpt in a GitHub issue.
