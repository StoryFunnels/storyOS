import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { TEMPLATES } from '../src/templates/definitions';
const LIFECYCLE = /^(status|state|stage|phase)$/i;
it('analysis', () => {
  const rows: string[] = [];
  let multi = 0;
  for (const t of TEMPLATES) {
    for (const db of t.databases ?? []) {
      const cands = (db.fields ?? []).filter(
        (f: { display_name?: string; type?: string }) => LIFECYCLE.test(f.display_name ?? '') && f.type === 'select',
      );
      if (cands.length > 0) {
        rows.push(`${t.slug} | ${db.name} | ${cands.map((c: {display_name?:string}) => c.display_name).join(',')}`);
        if (cands.length > 1) multi++;
      }
    }
  }
  writeFileSync('/tmp/218.txt', `CANDIDATES ${rows.length} MULTI ${multi}\n` + rows.join('\n'));
});
