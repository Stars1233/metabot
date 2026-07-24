import type { AgentTeamStore } from './team-store.js';

function compact(value: string | undefined, fallback: string): string {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return (normalized || fallback).slice(0, 120);
}

/**
 * Build the deliberately small Agent Team index exposed to a model.
 * Tasks, messages, runs, outputs, and member prompts stay out of the context;
 * the model can query durable state through `metabot teams` when needed.
 */
export function buildAgentTeamPromptContext(store: AgentTeamStore, teamName: string): string | undefined {
  const team = store.getTeam(teamName);
  if (!team || team.status !== 'active') return undefined;

  const members = store
    .listAgents(teamName)
    .filter((agent) => agent.status !== 'stopped')
    .map(
      (agent) =>
        `- ${compact(agent.name, 'member')} — ${compact(agent.role, 'member')} · ${agent.engine ?? 'codex'} · ${agent.status}`,
    );

  return [
    '## Team Context',
    `Team: ${compact(team.name, teamName)}`,
    'Members:',
    ...(members.length > 0 ? members : ['- none']),
    '',
    'Multiple dispatches to the same Agent are independent Runs.',
    'Delegate with:',
    `metabot teams dispatch ${compact(team.name, teamName)} <member> "<subject>" --description "..."`,
  ].join('\n');
}

/** Return prompt context only when this chat is explicitly bound to an active Team. */
export function buildAgentTeamPromptContextForChat(store: AgentTeamStore, chatId: string): string | undefined {
  const team = store.findTeamForChat(chatId);
  return team ? buildAgentTeamPromptContext(store, team.name) : undefined;
}
