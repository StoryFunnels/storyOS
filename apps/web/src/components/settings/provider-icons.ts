import {
  ArrowDownToLine,
  AtSign,
  Bot,
  Braces,
  CalendarDays,
  GitBranch,
  Mail,
  MessageSquare,
  MessagesSquare,
  ShoppingBag,
  Sparkles,
  Users,
  Video,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { ProviderPageId } from '@/lib/provider-pages';

/**
 * Icons are the one thing the registry doesn't carry (`packages/schemas` has no business depending on `lucide-react`): the
 * client-rendering half of a provider's identity, next to the page registry in `lib/provider-pages.ts`.
 */
export const PROVIDER_ICONS: Record<ProviderPageId, LucideIcon> = {
  github: GitBranch,
  linear: ArrowDownToLine,
  slack: MessageSquare,
  youtube: Video,
  'google-calendar': CalendarDays,
  shopify: ShoppingBag,
  email: Mail,
  'custom-api': Braces,
  meta: MessagesSquare,
  x: AtSign,
  linkedin: Users,
  apify: Workflow,
  openai: Sparkles,
  'delegate-agent': Bot,
};
