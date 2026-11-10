/**
 * Ticket #1214 AC4 — who a comment is SHOWN as written by.
 *
 * A comment posted by an agent run is stored with `author` = the agent's
 * manager (the actor is always the member) and `source = 'agent'` plus
 * `agent_name`. Rendering `author.name` made the manager look like the writer.
 * Every surface that draws a comment author goes through this one function.
 *
 * Falls back to the person whenever the agent identity is not usable: a
 * non-agent or unknown (null) source, or an agent with no/blank name. Never
 * returns a blank name and never the string 'undefined'.
 */
export interface CommentAuthorInput {
  author: { id: string; name: string; image: string | null };
  source: 'human' | 'agent' | 'automation' | 'mcp' | null;
  agent_name: string | null;
}

export type CommentAuthorView =
  | { kind: 'agent'; name: string }
  | { kind: 'person'; name: string; userId: string; image: string | null };

export function commentAuthorView(comment: CommentAuthorInput): CommentAuthorView {
  const agentName = typeof comment.agent_name === 'string' ? comment.agent_name.trim() : '';
  if (comment.source === 'agent' && agentName) return { kind: 'agent', name: agentName };
  return {
    kind: 'person',
    name: comment.author.name?.trim() || 'Unknown',
    userId: comment.author.id,
    image: comment.author.image,
  };
}
