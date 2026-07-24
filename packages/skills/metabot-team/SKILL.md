---
name: metabot-team
description: "Use for the MetaBot Agent Teams CLI: create and inspect durable Teams, spawn teammates, exchange messages, and manage Tasks and Runs across Sessions."
---

# MetaBot Agent Teams CLI

This Skill documents the `metabot teams` command surface and its durable-state
semantics. It does not define Agent execution policy.

## Core Model

Team = Agents + Messages + Tasks + Runs.

- Agents retain a stable Team identity across engine Sessions.
- Messages are the normal conversational handoff surface.
- Tasks record durable assignment, dependencies, status, and result.
- Runs record individual executions, output, failure, retry, cancellation, and
  card state.
- Multiple dispatches to the same Agent create independent Tasks and Runs.

## Inspect A Team

```bash
metabot teams status <team> --summary
metabot teams agents list <team>
metabot teams tasks list <team> --summary
metabot teams runs list <team> --summary
metabot teams next <team> <member> --summary
```

`--summary` or `--plain` selects concise output. The default output is JSON.

## Create And Dispatch

```bash
metabot teams create <team> --description "..."
metabot teams agents spawn <team> <member> --role <role> --prompt "..."
metabot teams dispatch <team> <member> "<subject>" --description "..." --plain
metabot teams send <team> <member> "<message>" --from <sender>
metabot teams inbox <team> <member> --summary
```

`dispatch` creates the Task/message/Run projection used by the supervisor. A
teammate's final response returns through Team state and the configured display
destination.

The default maximum parallel Runs per Agent is `4`, configurable with
`METABOT_AGENT_TEAM_MAX_PARALLEL_PER_AGENT`.

## Tasks And Runs

```bash
metabot teams tasks get <team> <taskId>
metabot teams tasks claim <team> <taskId> <member>
metabot teams tasks done <team> <taskId> "<result>"
metabot teams tasks block <team> <taskId> "<reason>" --blocked-by <id,id>
metabot teams runs list <team>
metabot teams runs output <team> <runId>
metabot teams runs stop <team> <runId>
```

Run statuses are `running`, `completed`, `failed`, and `stopped`. Stopping a
supervisor-owned Run asks the bridge to stop the execution and prevents late
output from replacing terminal state. Assigned in-progress Tasks may return to
pending for retry.

## Delivery Boundary

- Team status and cards are projections of the local Team store.
- Bus or inbox delivery does not give a remote worker access to the sender's
  local Team store.
- A wait timeout may leave durable Task/Run state pending; returned identifiers
  remain the recovery handles.
- The injected Team Context is a compact roster and dispatch hint. Tasks,
  messages, Runs, outputs, and member prompts remain query-only durable state.
