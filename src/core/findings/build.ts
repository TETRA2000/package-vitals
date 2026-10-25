import { chainsTo, devOnly, relationshipOf, type DepGraph } from '../lockfiles/graph.js';
import type { ProjectScan } from '../lockfiles/scan.js';
import { osvFixedVersion, osvPackageKey, osvRangeText, type OsvAdvisory } from '../osv/osv.js';
import type { DependabotAlert, FindingRecord, PackageEcosystem, Severity, SeveritySource } from '../types.js';
import { compareVersions, inVulnerableRange } from '../versions.js';
import { tierOne } from './tier-one.js';

// Joins one repo's Dependabot alerts, parsed lockfiles, and OSV results into findings: one per open alert,
// then one per group of linked OSV advisories that no alert accounts for. Pure and deterministic.

/** `targets`: the node IDs of the installed vulnerable instances in `projectPath`'s graph. */
export interface BuiltFinding {
  record: FindingRecord;
  projectPath: string | null;
  targets: number[];
}

type OkProject = ProjectScan & { result: { status: 'ok'; graph: DepGraph } };
type Facts = Pick<FindingRecord, 'installedVersions' | 'relationship' | 'chains' | 'chainCount' | 'lockfileRead' | 'lockfileDevOnly' | 'jsBundler'>;
/** An advisory and the nodes (installed versions) of one package that OSV reported it for. */
interface Reported { advisory: OsvAdvisory; nodes: number[] }

const CHAIN_LIMIT = 10;
/** A manifest that Dependabot may name instead of the lockfile beside it. A Map, so no prototype member matches. */
const MANIFESTS = new Map<string, string>([['package.json', 'npm'], ['Gemfile', 'rubygems']]);
/** An alert in these states accounts for an OSV match. A fixed one doesn't: the lockfile still has the package. */
const ACCOUNTING_STATES = new Set<string>(['open', 'dismissed', 'auto_dismissed']);
const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const SOURCE_RANK: Record<SeveritySource, number> = { assumed: 0, malware: 1, advisory: 2 };

const isOk = (p: ProjectScan): p is OkProject => p.result.status === 'ok';
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const dirname = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.');
const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The read lockfile behind an alert: the one at its manifest path, or the only one beside its package.json or Gemfile.
 * Lockfiles that couldn't be read count as candidates, so one that may be Dependabot's is never passed over.
 */
function projectFor(alert: DependabotAlert, projects: ProjectScan[]): OkProject | null {
  const sameEcosystem = projects.filter((p) => p.ecosystem === alert.ecosystem);
  const exact = sameEcosystem.find((p) => p.path === alert.manifestPath);
  if (exact) return isOk(exact) ? exact : null;
  if (MANIFESTS.get(basename(alert.manifestPath)) !== alert.ecosystem) return null;
  const beside = sameEcosystem.filter((p) => dirname(p.path) === dirname(alert.manifestPath));
  const only = beside.length === 1 ? beside[0]! : null;
  return only !== null && isOk(only) ? only : null;
}

/** The advisory names the alert's GHSA ID, or its CVE when it has one, as its ID or an alias. */
function matches(a: OsvAdvisory, alert: DependabotAlert): boolean {
  const names = (id: string | null) => id !== null && id !== '' && (a.id === id || a.aliases.includes(id));
  return names(alert.ghsaId) || names(alert.cveId);
}

/** What OSV reported for a node. Only registry nodes are looked up. */
function reportedAt(osv: Map<string, OsvAdvisory[]>, project: OkProject, id: number): OsvAdvisory[] {
  const n = project.result.graph.nodes[id]!;
  return n.registry ? (osv.get(osvPackageKey({ ecosystem: project.ecosystem, name: n.name, version: n.version })) ?? []) : [];
}

const isValid = (ecosystem: PackageEcosystem, v: string) => compareVersions(ecosystem, v, v) !== null;

/** Unique, in version order, with versions that can't be compared last in string order. */
function versionOrder(ecosystem: PackageEcosystem, versions: string[]): string[] {
  return [...new Set(versions)].sort((a, b) => {
    const va = isValid(ecosystem, a);
    if (va !== isValid(ecosystem, b)) return va ? -1 : 1;
    return (va ? compareVersions(ecosystem, a, b)! : 0) || byString(a, b);
  });
}

/**
 * What the lockfile says about the vulnerable copies (`targets`) of package `name`. Dev-only is judged over every
 * installed copy of the package, at any version: if one ships, the package ships.
 */
function lockfileFacts(project: OkProject | null, name: string, targets: number[]): Facts {
  if (project === null) {
    return { installedVersions: [], relationship: null, chains: [], chainCount: 0, lockfileRead: false, lockfileDevOnly: null, jsBundler: null };
  }
  const g = project.result.graph;
  const copies = g.nodes.flatMap((n, id) => (n.name === name ? [id] : []));
  const { chains, total } = chainsTo(g, targets, CHAIN_LIMIT);
  return {
    installedVersions: versionOrder(project.ecosystem, targets.map((t) => g.nodes[t]!.version)),
    relationship: relationshipOf(g, targets),
    chains,
    chainCount: total,
    lockfileRead: true,
    lockfileDevOnly: devOnly(g, copies),
    jsBundler: project.jsBundler,
  };
}

const withTier = (r: Omit<FindingRecord, 'tier'>): FindingRecord => ({ ...r, tier: tierOne(r) });

// ---- Dependabot findings ----

/**
 * The vulnerable copies of an alert's package: those its range doesn't rule out, including versions it can't compare,
 * and those OSV lists its advisory for. An alert carries one of the advisory's ranges, so OSV can see more.
 */
function alertTargets(alert: DependabotAlert, project: OkProject, osv: Map<string, OsvAdvisory[]> | null): number[] {
  const listed = (id: number) => osv !== null && reportedAt(osv, project, id).some((a) => matches(a, alert));
  return project.result.graph.nodes.flatMap((n, id) =>
    n.name === alert.packageName && (inVulnerableRange(project.ecosystem, n.version, alert.vulnerableRange) !== false || listed(id))
      ? [id]
      : []);
}

function alertFinding(alert: DependabotAlert, projects: ProjectScan[], osv: Map<string, OsvAdvisory[]> | null): BuiltFinding {
  const project = projectFor(alert, projects);
  const targets = project === null ? [] : alertTargets(alert, project, osv);
  const both = project !== null && osv !== null && targets.some((t) => reportedAt(osv, project, t).some((a) => matches(a, alert)));
  const record = withTier({
    alertNumber: alert.number,
    source: both ? 'both' : 'dependabot',
    ecosystem: alert.ecosystem,
    packageName: alert.packageName,
    manifestPath: alert.manifestPath,
    advisoryId: alert.ghsaId,
    cveId: alert.cveId,
    severity: alert.severity,
    severitySource: 'advisory',
    summary: alert.summary,
    vulnerableRange: alert.vulnerableRange,
    firstPatched: alert.firstPatched,
    createdAt: alert.createdAt,
    scope: alert.scope,
    githubRelationship: alert.relationship,
    ...lockfileFacts(project, alert.packageName, targets),
    upgrades: null,
  });
  return { record, projectPath: project?.path ?? null, targets };
}

// ---- OSV-only findings ----

/** Advisories that share an ID or alias, directly or through others, in groups. */
function linked(members: Reported[]): Reported[][] {
  const parent = members.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const owner = new Map<string, number>();
  members.forEach((m, i) => {
    for (const name of [m.advisory.id, ...m.advisory.aliases]) {
      if (name === '') continue;
      const j = owner.get(name);
      if (j === undefined) owner.set(name, i);
      else parent[find(i)] = find(j);
    }
  });
  const groups = new Map<number, Reported[]>();
  members.forEach((m, i) => {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(m);
    else groups.set(root, [m]);
  });
  return [...groups.values()];
}

const rank = (a: OsvAdvisory) => SEVERITY_RANK[a.severity] * 3 + SOURCE_RANK[a.severitySource];
const cveAlias = (a: OsvAdvisory) => a.aliases.find((x) => x.startsWith('CVE-'));

function osvFinding(project: OkProject, name: string, group: Reported[]): BuiltFinding {
  const advisories = group.map((m) => m.advisory).sort((a, b) => byString(a.id, b.id));
  const representative = advisories.find((a) => a.id.startsWith('GHSA-')) ?? advisories[0]!;
  // The highest severity; at equal severity an advisory's own beats a malware record's, which beats an assumed one.
  const worst = advisories.reduce((w, a) => (rank(a) > rank(w) ? a : w));
  const targets = [...new Set(group.flatMap((m) => m.nodes))].sort((a, b) => a - b);
  const facts = lockfileFacts(project, name, targets);
  const highest = facts.installedVersions.findLast((v) => isValid(project.ecosystem, v));
  const record = withTier({
    alertNumber: null,
    source: 'osv',
    ecosystem: project.ecosystem,
    packageName: name,
    manifestPath: project.path,
    advisoryId: representative.id,
    cveId: cveAlias(representative) ?? advisories.map(cveAlias).find((c) => c !== undefined) ?? null,
    severity: worst.severity,
    severitySource: worst.severitySource,
    summary: representative.summary,
    vulnerableRange: osvRangeText(representative),
    firstPatched: highest === undefined ? null : osvFixedVersion(representative, project.ecosystem, highest),
    createdAt: null,
    scope: null,
    githubRelationship: null,
    ...facts,
    upgrades: null,
  });
  return { record, projectPath: project.path, targets };
}

/** One project's OSV results, grouped per package by linked advisories, less those an alert accounts for. */
function osvFindings(project: OkProject, accounting: DependabotAlert[], osv: Map<string, OsvAdvisory[]>): BuiltFinding[] {
  const byPackage = new Map<string, Map<string, Reported>>();
  project.result.graph.nodes.forEach((n, id) => {
    for (const advisory of reportedAt(osv, project, id)) {
      let byId = byPackage.get(n.name);
      if (!byId) byPackage.set(n.name, (byId = new Map()));
      const seen = byId.get(advisory.id);
      if (seen) seen.nodes.push(id);
      else byId.set(advisory.id, { advisory, nodes: [id] });
    }
  });
  const out: BuiltFinding[] = [];
  for (const [name, byId] of byPackage) {
    for (const group of linked([...byId.values()])) {
      const accounted = accounting.some((alert) => alert.packageName === name && group.some((m) => matches(m.advisory, alert)));
      if (!accounted) out.push(osvFinding(project, name, group));
    }
  }
  return out;
}

export function buildRepoFindings(input: {
  alerts: DependabotAlert[];
  projects: ProjectScan[];
  osv: Map<string, OsvAdvisory[]> | null;
}): BuiltFinding[] {
  const fromAlerts = input.alerts
    .filter((a) => a.state === 'open')
    .map((a) => alertFinding(a, input.projects, input.osv))
    .sort((x, y) => x.record.alertNumber! - y.record.alertNumber!);
  const osv = input.osv;
  if (osv === null) return fromAlerts;

  // Each open, dismissed, or auto-dismissed alert accounts for matching OSV results in its own project only.
  const accounting = new Map<OkProject, DependabotAlert[]>();
  for (const alert of input.alerts) {
    const project = ACCOUNTING_STATES.has(alert.state) ? projectFor(alert, input.projects) : null;
    if (project === null) continue;
    const list = accounting.get(project);
    if (list) list.push(alert);
    else accounting.set(project, [alert]);
  }
  const fromOsv = input.projects
    .filter(isOk)
    .flatMap((p) => osvFindings(p, accounting.get(p) ?? [], osv))
    .sort((x, y) =>
      byString(x.record.packageName, y.record.packageName) ||
      byString(x.record.advisoryId, y.record.advisoryId) ||
      byString(x.record.manifestPath, y.record.manifestPath));
  return [...fromAlerts, ...fromOsv];
}
