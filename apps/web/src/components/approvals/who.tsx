'use client';

import { Avatar } from '@/components/ui/avatar';
import { AgentAvatar } from '@/components/tyron/agent-avatar';
import { type Who } from './caused-by';

/**
 * The avatar beside a notification's "who" (ticket #1193): the shared agent mark for an agent-caused approval (the rule
 * author's photo would name the wrong party), the person's avatar for a person, and the plain bare disc for StoryOS. The
 * agent mark is the existing `AgentAvatar`, resized here, so no surface re-draws it.
 */
const BOX = { 18: 'h-[18px] w-[18px]', 24: 'h-6 w-6', 32: 'h-8 w-8' } as const;

export function WhoAvatar({ who, size }: { who: Who; size: keyof typeof BOX }) {
  if (who.kind === 'agent') {
    // 18px is the dense Inbox row (ticket #1279): the same mark at the "sm" glyph size, not a re-drawn one.
    return <AgentAvatar name={who.name} size={size === 18 ? 'sm' : 'md'} className={BOX[size]} />;
  }
  if (who.kind === 'person') {
    return <Avatar userId={who.actor.id} name={who.actor.name} image={who.actor.image} size={size} />;
  }
  return <span className={`${BOX[size]} rounded-full bg-hover`} />;
}
