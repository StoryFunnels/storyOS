/** Pure chunking helper, shared by every batch/bulk write path that needs to
 * bound a single transaction/loop pass rather than process one unbounded
 * array at once (migration-framework/chunked-apply.service.ts, records
 * batch update/delete — #653). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
