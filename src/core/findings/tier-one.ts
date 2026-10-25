// Tier 1: a finding is "not shipped" only when nothing says runtime and something says dev-only.
// Every input left in doubt keeps the finding (null), since a wrong "not shipped" hides a real problem.

export interface TierOneInput {
  ecosystem: string;
  scope: 'runtime' | 'development' | null;
  lockfileRead: boolean;
  lockfileDevOnly: boolean | null;
  jsBundler: string | null;
}

export function tierOne(f: TierOneInput): 'not_shipped' | null {
  // Any source saying runtime keeps it.
  if (f.scope === 'runtime' || f.lockfileDevOnly === false) return null;
  if (f.ecosystem === 'npm') {
    // A bundler can ship dev dependencies, so npm needs the lockfile read and no bundler found.
    return f.lockfileRead && f.lockfileDevOnly === true && f.jsBundler === null ? 'not_shipped' : null;
  }
  if (f.ecosystem === 'rubygems') {
    // Dependabot's development scope is enough only when no lockfile was read to say otherwise.
    return f.lockfileDevOnly === true || (!f.lockfileRead && f.scope === 'development') ? 'not_shipped' : null;
  }
  // Other ecosystems stay not triaged (spec Section 5).
  return null;
}
