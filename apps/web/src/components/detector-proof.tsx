/**
 * THROWAWAY — ticket #722 AC4 proof that the contrast advisory's diff half
 * actually detects in CI, not just that it runs. DO NOT MERGE THIS BRANCH.
 *
 * Two deliberately faint sites below. Both should appear by file and line in
 * the "New `--text-faint` sites" section of the CI step summary, making the
 * count NON-ZERO — the only reading that distinguishes "looked and found
 * nothing" from "could not look".
 */
export function DetectorProof() {
  return (
    <div>
      <span className="text-faint">deliberately faint prose, ticket #722</span>
      <p className="text-meta text-faint">a second faint site, so the count reads 2</p>
    </div>
  );
}
