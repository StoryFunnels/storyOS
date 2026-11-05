import { Database } from 'lucide-react';
import { EntityIcon } from '@/components/ui/icon-picker';
import { GlyphSlot } from '@/components/sidebar-row';
import { databaseColor } from '@/lib/entity-color';

/**
 * The ONE way a database's glyph is drawn: its own icon in its own colour, else the
 * default database mark in the colour derived from its id (never a grey).
 *
 * The sidebar's database row and the workspace home's "Where to go" cards both render
 * this component. Ticket #1207 was a second surface that drew a hard-coded generic
 * database icon beside a sidebar that showed each database's own; do not re-case it.
 *
 * #1001 — the fallback carries no `text-muted`: it would override the colour the icon's
 * wrapper hands down, and every database would draw the same grey whatever colour it had.
 */
export function DatabaseGlyph({
  icon,
  color,
  id,
}: {
  icon: string | null | undefined;
  color: string | null | undefined;
  id: string;
}) {
  return (
    <GlyphSlot>
      <EntityIcon icon={icon} color={databaseColor(color, id)} fallback={<Database className="h-3.5 w-3.5" />} />
    </GlyphSlot>
  );
}
