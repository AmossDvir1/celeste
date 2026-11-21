import { AGENT_TOOL_NAMES } from '@shared/subagents'

/*
 * The assistant's own tools for helpers are shown as helper cards, not as tool cards, so the translators of the four vendors leave their
 * calls out of the log (docs/plans/SUB_AGENTS_PLAN.md, 6.1). The call is still answered and its result still reaches the model: only the
 * events that would draw a card are not emitted.
 */

/** The bare names, as Celeste's tool server lists them. */
export const HIDDEN_OWN_TOOLS: ReadonlySet<string> = new Set(AGENT_TOOL_NAMES)

/**
 * True for a call of one of those tools, whatever the vendor calls it: `mcp__celeste-devices__agent_start` (Claude), the server `celeste_devices`
 * with the tool `agent_start` (Codex), `mcp_celeste-devices_agent_start` (Gemini), a server name and a tool name (Copilot). Every piece the vendor
 * gives (the name, the server, a title) can be passed; together they must carry Celeste's server name and one of the five tool names. A tool of the
 * person's own with the same bare name, from another server, is not hidden.
 */
export function isOwnAgentTool(...parts: (string | undefined | null)[]): boolean {
  const text = parts.filter(Boolean).join(' ')
  return /celeste[-_]devices/.test(text) && /(?<![A-Za-z0-9])agent_(?:start|send|wait|stop|list)(?![A-Za-z0-9_])/.test(text)
}
