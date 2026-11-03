'use client';

import { Avatar } from '@/components/ui/avatar';
import { AgentAvatar } from '@/components/tyron/agent-avatar';
import { type Who } from './caused-by';

/**
 * The avatar beside a notification's "who" (ticket #1193): the shared agent mark for an agent-caused approval (the rule
 * author's photo would name the wrong party), the person's avatar for a person, and the plain bare disc for StoryOS. The
 * agent mark is the existing `AgentAvatar`, resized here, so no surface re-draws it.
 */
export function WhoAvatar({ who, size }: { who: Who; size: 24 | 32 }) {
  if (who.kind === 'agent') {
    return <AgentAvatar name={who.name} size="md" className={size === 24 ? 'h-6 w-6' : 'h-8 w-8'} />;
  }
  if (who.kind === 'person') {
    return <Avatar userId={who.actor.id} name={who.actor.name} image={who.actor.image} size={size} />;
  }
  return <span className={size === 24 ? 'h-6 w-6 rounded-full bg-hover' : 'h-8 w-8 rounded-full bg-hover'} />;
}
