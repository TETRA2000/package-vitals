import type { DepGraph } from '../lockfiles/graph.js';
import type { PackageEcosystem, Upgrade } from '../types.js';
import { compareVersions, isStableVersion } from '../versions.js';
import type { RegistryVersion } from './registry.js';

/** True when `latest` is newer than `locked`; null when either can't be compared. */
export function isOutdated(ecosystem: PackageEcosystem, locked: string, latest: string): boolean | null {
  const order = compareVersions(ecosystem, locked, latest);
  return order === null ? null : order < 0;
}

/**
 * Direct dependencies to upgrade so the targets leave the graph. For each direct package that leads to a
 * target, it picks the lowest stable, non-deprecated, newer release that no longer declares any child that
 * leads to a target, then checks that the targets are unreachable once those links are gone.
 * Null when that can't be shown: a target is itself direct, no release drops the link, a registry answer
 * is missing, or another chain still reaches a target.
 */
export function planDirectUpgrades(
  ecosystem: PackageEcosystem,
  graph: DepGraph,
  targets: number[],
  versionsOf: (name: string) => RegistryVersion[] | null,
): Upgrade[] | null {
  const n = graph.nodes.length;
  const valid = (id: number) => Number.isInteger(id) && id >= 0 && id < n;
  const targetIds = new Set(targets.filter(valid));
  if (targetIds.size === 0) return null;
  const childrenOf = (id: number) => (graph.edges[id] ?? []).map((e) => e.to).filter(valid);
  const rootTargets = graph.roots.flatMap((r) => r.edges.map((e) => e.to)).filter(valid);
  const direct = new Set(rootTargets);
  if ([...targetIds].some((t) => direct.has(t))) return null;

  // leads[id]: the node is a target or reaches one. Found by walking edges backwards from the targets.
  const parents: number[][] = Array.from({ length: n }, () => []);
  for (let id = 0; id < n; id++) for (const c of childrenOf(id)) parents[c]!.push(id);
  const leads = new Set(targetIds);
  const queue = [...targetIds];
  for (let i = 0; i < queue.length; i++) {
    for (const p of parents[queue[i]!]!) {
      if (!leads.has(p)) {
        leads.add(p);
        queue.push(p);
      }
    }
  }

  const cut = new Set<string>(); // "parent>child" links to remove
  const found = new Map<string, Upgrade>();
  for (const d of [...direct].sort((a, b) => a - b)) {
    if (!leads.has(d)) continue;
    const node = graph.nodes[d]!;
    const blockers = [...new Set(childrenOf(d))].filter((c) => leads.has(c));
    const blockerNames = new Set(blockers.map((b) => graph.nodes[b]!.name));
    if (compareVersions(ecosystem, node.version, node.version) === null) return null;
    const candidates = (versionsOf(node.name) ?? [])
      .filter((r) => isStableVersion(ecosystem, r.version) && !r.deprecated && compareVersions(ecosystem, r.version, node.version)! > 0)
      .sort((a, b) => compareVersions(ecosystem, a.version, b.version)!);
    const pick = candidates.find((r) => r.dependencies.every((dep) => !blockerNames.has(dep)));
    if (pick === undefined) return null;
    for (const b of blockers) cut.add(`${d}>${b}`);
    found.set(`${node.name}\0${node.version}\0${pick.version}`, { name: node.name, from: node.version, to: pick.version });
  }
  if (found.size === 0) return null;

  // With those links gone, no root may still reach a target.
  const seen = new Uint8Array(n);
  const stack = rootTargets.filter((id) => !seen[id] && (seen[id] = 1));
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (targetIds.has(id)) return null;
    for (const c of childrenOf(id)) {
      if (!seen[c] && !cut.has(`${id}>${c}`)) {
        seen[c] = 1;
        stack.push(c);
      }
    }
  }
  return [...found.values()].sort((a, b) => (a.name !== b.name ? (a.name < b.name ? -1 : 1) : a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}
