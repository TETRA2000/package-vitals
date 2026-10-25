import type { ChainLink, DependencyChain, Relationship } from '../types.js';

// The dependency graph every lockfile parser produces, and the questions asked of it.
// Every traversal is iterative, so cycles end and deep graphs don't overflow the stack.

export type LockfileFormat = 'npm-v1' | 'npm-v2' | 'npm-v3' | 'yarn-v1' | 'pnpm-v9' | 'bundler';

export type EdgeKind = 'prod' | 'dev' | 'optional' | 'peer';

export interface DepEdge {
  to: number;
  kind: EdgeKind;
}

/** `registry`: comes from the public registry, not git, a path, or a tarball. `lockDev`: the lockfile's own dev flag, null when the format has none. */
export interface DepNode {
  id: number;
  name: string;
  version: string;
  registry: boolean;
  lockDev: boolean | null;
}

/** A project or workspace package. Its edges are its declared dependencies; only root edges can be 'dev'. */
export interface DepRoot {
  label: string;
  path: string;
  edges: DepEdge[];
}

export interface DepGraph {
  format: LockfileFormat;
  roots: DepRoot[];
  nodes: DepNode[]; // nodes[i].id === i
  edges: DepEdge[][]; // edges[nodeId]: that package's own dependencies
  unresolved: string[]; // required dependencies the lockfile doesn't resolve, as "<from> > <name>"
  devKnown: boolean; // false when dev and runtime can't be told apart (a Gemfile that couldn't be read)
}

export type ParseResult =
  | { status: 'ok'; graph: DepGraph }
  | { status: 'unsupported'; format: string; message: string }
  | { status: 'error'; message: string };

/** Shortest chains are counted up to this many, never enumerated. */
const MAX_CHAIN_COUNT = 10_000;

const isNode = (g: DepGraph, id: number) => Number.isInteger(id) && id >= 0 && id < g.nodes.length;
const childrenOf = (g: DepGraph, id: number): DepEdge[] => g.edges[id] ?? [];

// Only a root's dev edge is dev. Anything else, including a kind we don't know, counts as runtime.
const isRuntimeRootEdge = (e: DepEdge) => e.kind !== 'dev';

/** Every node reachable from `starts`, following every node edge. */
function walk(g: DepGraph, starts: number[]): Set<number> {
  const seen = new Uint8Array(g.nodes.length);
  const queue: number[] = [];
  const visit = (id: number) => {
    if (isNode(g, id) && !seen[id]) {
      seen[id] = 1;
      queue.push(id);
    }
  };
  for (const id of starts) visit(id);
  for (let i = 0; i < queue.length; i++) {
    for (const e of childrenOf(g, queue[i]!)) visit(e.to);
  }
  return new Set(queue);
}

const rootEdges = (g: DepGraph) => g.roots.flatMap((r) => r.edges);

/** Roots are known, every required dependency resolves, and dev can be told from runtime. */
export function isComplete(g: DepGraph): boolean {
  return g.roots.length > 0 && g.unresolved.length === 0 && g.devKnown;
}

export function reachable(g: DepGraph): Set<number> {
  return walk(g, rootEdges(g).map((e) => e.to));
}

/** Reachable from a root's prod, optional, or peer edge. A package's own dependencies are always runtime. */
export function runtimeReachable(g: DepGraph): Set<number> {
  return walk(g, rootEdges(g).filter(isRuntimeRootEdge).map((e) => e.to));
}

/** Packages some root declares itself. */
export function directIds(g: DepGraph): Set<number> {
  return new Set(rootEdges(g).map((e) => e.to).filter((id) => isNode(g, id)));
}

/**
 * True only when every target is installed, reachable, and reachable only through dev root edges,
 * and the lockfile's own dev flag doesn't disagree. Null when the graph can't tell.
 */
export function devOnly(g: DepGraph, targets: number[]): boolean | null {
  if (!isComplete(g) || targets.length === 0) return null;
  const all = reachable(g);
  if (targets.some((t) => !all.has(t))) return null;
  const runtime = runtimeReachable(g);
  if (targets.some((t) => runtime.has(t) || g.nodes[t]!.lockDev === false)) return false;
  return true;
}

/**
 * A target is direct when a root declares it, and transitive when it's only reached through other packages.
 * Targets nothing reaches don't count. Null when no target counts.
 */
export function relationshipOf(g: DepGraph, targets: number[]): Relationship | null {
  const direct = directIds(g);
  const all = reachable(g);
  let hasDirect = false;
  let hasTransitive = false;
  for (const t of targets) {
    if (direct.has(t)) hasDirect = true;
    else if (all.has(t)) hasTransitive = true;
  }
  if (hasDirect && hasTransitive) return 'mixed';
  if (hasDirect) return 'direct';
  if (hasTransitive) return 'transitive';
  return null;
}

// Name, then version, then id, so the order is the same on every run.
function compareNodes(g: DepGraph, a: number, b: number): number {
  const x = g.nodes[a]!;
  const y = g.nodes[b]!;
  if (x.name !== y.name) return x.name < y.name ? -1 : 1;
  if (x.version !== y.version) return x.version < y.version ? -1 : 1;
  return a - b;
}

const linkOf = (g: DepGraph, id: number): ChainLink => ({ name: g.nodes[id]!.name, version: g.nodes[id]!.version });

/**
 * The shortest chains from any root to each target, ordered by length, then root order, then links
 * (each compared by name, then version). `total` counts every shortest chain, up to 10,000.
 */
export function chainsTo(
  g: DepGraph,
  targets: number[],
  limit = 10,
): { chains: DependencyChain[]; total: number } {
  const n = g.nodes.length;

  // Breadth-first from every direct dependency at once: dist is a node's shortest chain length (0: unreached),
  // and ways counts its shortest chains, one per root at the first link.
  const dist = new Int32Array(n);
  const ways = new Float64Array(n);
  const order: number[] = [];
  for (const r of g.roots) {
    const seen = new Set<number>();
    for (const e of r.edges) {
      if (!isNode(g, e.to) || seen.has(e.to)) continue;
      seen.add(e.to);
      ways[e.to] = Math.min(MAX_CHAIN_COUNT, ways[e.to]! + 1);
      if (dist[e.to] === 0) {
        dist[e.to] = 1;
        order.push(e.to);
      }
    }
  }
  // Breadth-first order puts every node after all nodes one link closer, so ways[u] is final when u is reached.
  const lastFrom = new Int32Array(n).fill(-1);
  for (let i = 0; i < order.length; i++) {
    const u = order[i]!;
    for (const e of childrenOf(g, u)) {
      const v = e.to;
      if (!isNode(g, v) || lastFrom[v] === u) continue;
      lastFrom[v] = u;
      if (dist[v] === 0) {
        dist[v] = dist[u]! + 1;
        order.push(v);
      }
      if (dist[v] === dist[u]! + 1) ways[v] = Math.min(MAX_CHAIN_COUNT, ways[v]! + ways[u]!);
    }
  }

  const wanted = [...new Set(targets)].filter((t) => isNode(g, t) && dist[t]! > 0);
  const total = Math.min(MAX_CHAIN_COUNT, wanted.reduce((sum, t) => sum + ways[t]!, 0));

  const chains: DependencyChain[] = [];
  const lengths = [...new Set(wanted.map((t) => dist[t]!))].sort((a, b) => a - b);
  for (const length of lengths) {
    if (chains.length >= limit) break;
    // onChain[u]: u is a link of some shortest chain to a target of this length. Filled from the far end back.
    const onChain = new Uint8Array(n);
    for (const t of wanted) if (dist[t] === length) onChain[t] = 1;
    const continues = (u: number, v: number) => isNode(g, v) && onChain[v] === 1 && dist[v] === dist[u]! + 1;
    for (let i = order.length - 1; i >= 0; i--) {
      const u = order[i]!;
      if (dist[u]! < length && childrenOf(g, u).some((e) => continues(u, e.to))) onChain[u] = 1;
    }
    const nextLinks = (u: number) =>
      [...new Set(childrenOf(g, u).map((e) => e.to))]
        .filter((v) => continues(u, v))
        .sort((a, b) => compareNodes(g, a, b));

    for (const r of g.roots) {
      if (chains.length >= limit) break;
      // A first link is dev only when every edge from this root to it is dev.
      const devFirst = new Map<number, boolean>();
      for (const e of r.edges) {
        if (isNode(g, e.to) && onChain[e.to]) devFirst.set(e.to, (devFirst.get(e.to) ?? true) && e.kind === 'dev');
      }
      const firsts = [...devFirst.keys()].sort((a, b) => compareNodes(g, a, b));

      // Depth-first in link order, with an explicit stack. Every branch ends at a target,
      // so this stops after `limit` chains however many there are.
      const path: number[] = [];
      const stack: { next: number[]; i: number }[] = [{ next: firsts, i: 0 }];
      while (stack.length > 0 && chains.length < limit) {
        const top = stack[stack.length - 1]!;
        if (top.i >= top.next.length) {
          stack.pop();
          path.pop();
          continue;
        }
        const v = top.next[top.i++]!;
        path.push(v);
        if (dist[v] === length) {
          chains.push({ root: r.label, links: path.map((id) => linkOf(g, id)), dev: devFirst.get(path[0]!)! });
          path.pop();
        } else {
          stack.push({ next: nextLinks(v), i: 0 });
        }
      }
    }
  }
  return { chains, total };
}
