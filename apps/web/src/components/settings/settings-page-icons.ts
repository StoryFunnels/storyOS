import {
  Bell,
  Bot,
  ChartColumn,
  Download,
  Gift,
  History,
  Info,
  KeyRound,
  Link2,
  Lock,
  Package,
  Plug,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  User,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { SettingsPageId } from '@/lib/settings-nav';

/**
 * One icon per settings page, as an exhaustive `Record`: a page added to `SETTINGS_PAGES` without an icon here fails to compile,
 * so a row can never render with a blank glyph slot. (Referrals has no icon in the design; a gift is the obvious one.)
 */
export const SETTINGS_PAGE_ICONS: Record<SettingsPageId, LucideIcon> = {
  profile: User,
  preferences: SlidersHorizontal,
  notifications: Bell,
  referrals: Gift,
  general: Info,
  members: Users,
  billing: ChartColumn,
  packs: Package,
  'connect-ai': Sparkles,
  runners: Bot,
  'agent-rules': Lock,
  integrations: Plug,
  'api-tokens': KeyRound,
  webhooks: Link2,
  export: Download,
  trash: Trash2,
  'audit-log': History,
};
