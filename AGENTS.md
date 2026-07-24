# MetaBot Personal Edition Workspace

MetaBot connects chat-based agents with self-hosted Memory, Skills, Agent Bus,
Agent Teams, T5T, scheduling, and runtime operations. Use `metabot` as the
single CLI for these surfaces; legacy `mm`, `mh`, and `mb` workflows are
retired.

## Core CLI

```bash
metabot memory search "query"
metabot memory get <id|path>
metabot skills list
metabot agents list
metabot agents talk <agent> "message"
metabot inbox poll --loop
metabot teams status <team> --summary
metabot t5t push <project> <date> "entry"
```

Use the `metabot` Skill for command details and the `metabot-team` Skill for
durable Team state. Personal Core and its web console default to
`http://127.0.0.1:9200`; users may configure another Core with
`METABOT_CORE_URL`.

`AGENTS.md` is the canonical project instruction file. Existing workspace
`AGENTS.md` and `CLAUDE.md` files are user-owned and MetaBot install/update must
not replace them.

## Working Principles

- Start from the user's goal and inspect the actual workspace or runtime before
  acting.
- Carry authorized work through implementation and verification appropriate to
  its risk. Do not stop at a plan unless the user asked only for a plan.
- Keep changes focused and preserve unrelated files, local modifications, user
  data, configuration, and user-selected integrations.
- Choose the execution approach that best fits the task. Add coordination or
  extra process only when it materially helps the outcome.
- Use the injected Current MetaBot Context and Team Context as the current
  chat, schedule, roster, and routing source. Query `metabot teams` when more
  durable state is needed.
- Ask the user only when a missing decision, authority, credential, or unsafe
  action genuinely blocks progress.
- Never expose secrets or authorization tokens. Avoid destructive actions
  unless they are explicitly authorized and necessary.
- Before runtime or deployment work, verify the real target, current state, and
  rollback path. Do not assume host-specific paths, process names, or ports.
- Search before creating shared resources, and keep user-facing updates concise
  and evidence-backed.

## Durable State

- T5T records project progress, evidence, blockers, and next actions.
- Meta Memory records decisions, reusable findings, and final state.
- Skills document reusable CLI or integration behavior; project execution
  policy stays in project instructions rather than packaged Skills.
- Agent Teams provide durable Agents, Messages, Tasks, and Runs across engine
  sessions.

## Public Boundary

- Keep Personal Edition self-hostable and free of private identity providers,
  employee directories, internal domains, private endpoints, and embedded
  credentials.
- Preserve public Feishu/Lark, Telegram, WeChat, and other user-configured
  integrations.
- Treat `lark-cli` and its Skills as user-managed. Mirror selected existing
  Lark Skills without overwriting locally modified copies.
