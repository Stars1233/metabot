# Scheduling And Runtime Operations

Bridge-local commands exist only when listed by `metabot help`:

```bash
metabot schedule add <agent> <chatId> <delaySeconds> "<prompt>"
metabot schedule cron <agent> <chatId> "<cronExpr>" "<prompt>"
metabot update [--git|--package|--version <version>]
metabot restart
metabot status
metabot logs
metabot health
metabot bots
metabot peers
```

Schedules target Agent + Chat ID; the engine Session ID is diagnostic and may
change. Immutable release versions provide the package rollback surface.
