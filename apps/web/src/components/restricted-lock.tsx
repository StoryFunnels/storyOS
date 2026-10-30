import { Lock } from 'lucide-react';

/**
 * The lock that marks a RESTRICTED space or database (#924: a lock means restricted, nothing else). One definition so the
 * sidebar's rows and the space page's Contents cannot draw it differently. Callers gate it with `showsLock(item)`; it never
 * decides for itself, and a personal item never gets one (#1097).
 */
export function RestrictedLock() {
  return (
    <Lock className="h-[11px] w-[11px] shrink-0 text-faint" aria-label="Restricted" role="img">
      <title>Restricted — only the people added can see it</title>
    </Lock>
  );
}
