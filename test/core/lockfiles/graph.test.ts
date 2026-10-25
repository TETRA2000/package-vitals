import { describe, it, expect } from 'vitest';
import {
  chainsTo,
  devOnly,
  directIds,
  isComplete,
  reachable,
  relationshipOf,
  runtimeReachable,
  type DepEdge,
  type DepGraph,
  type DepNode,
  type DepRoot,
} from '../../../src/core/lockfiles/graph.js';

const node = (id: number, name: string, version = '1.0.0', lockDev: boolean | null = null): DepNode => ({
  id,
  name,
  version,
  registry: true,
  lockDev,
});

const root = (label: string, edges: DepEdge[]): DepRoot => ({ label, path: '', edges });

const graph = (g: { roots: DepRoot[]; nodes: DepNode[]; edges?: DepEdge[][] } & Partial<DepGraph>): DepGraph => ({
  format: 'npm-v3',
  unresolved: [],
  devKnown: true,
  ...g,
  edges: g.edges ?? g.nodes.map(() => []),
});

const prod = (to: number): DepEdge => ({ to, kind: 'prod' });
const dev = (to: number): DepEdge => ({ to, kind: 'dev' });

// app: prod→a→x and dev→b→x
const sharedX = () =>
  graph({
    roots: [root('app', [prod(0), dev(1)])],
    nodes: [node(0, 'a'), node(1, 'b'), node(2, 'x')],
    edges: [[prod(2)], [prod(2)], []],
  });

describe('reachability', () => {
  it('follows root edges, and runtime reachability skips dev root edges', () => {
    const g = sharedX();
    expect(reachable(g)).toEqual(new Set([0, 1, 2]));
    expect(runtimeReachable(g)).toEqual(new Set([0, 2]));
    expect(directIds(g)).toEqual(new Set([0, 1]));
  });

  it('isComplete needs roots, no unresolved dependency, and known groups', () => {
    expect(isComplete(sharedX())).toBe(true);
    expect(isComplete({ ...sharedX(), unresolved: ['a > gone'] })).toBe(false);
    expect(isComplete({ ...sharedX(), devKnown: false })).toBe(false);
    expect(isComplete({ ...sharedX(), roots: [] })).toBe(false);
  });
});

describe('devOnly', () => {
  it('a package reachable from a dev and a runtime dependency is not dev-only', () => {
    const g = sharedX();
    expect(devOnly(g, [2])).toBe(false);
    expect(devOnly(g, [1])).toBe(true);
    expect(devOnly(g, [1, 2])).toBe(false);
  });

  it('optional and peer edges are runtime', () => {
    const g = graph({
      roots: [root('app', [{ to: 0, kind: 'optional' }, { to: 1, kind: 'peer' }, dev(2)])],
      nodes: [node(0, 'a'), node(1, 'b'), node(2, 'c'), node(3, 'd'), node(4, 'e')],
      // A package's own dependencies are runtime whatever their kind.
      edges: [[], [], [dev(3)], [], []],
    });
    expect(devOnly(g, [0])).toBe(false);
    expect(devOnly(g, [1])).toBe(false);
    expect(devOnly(g, [3])).toBe(true);

    const nested = graph({
      roots: [root('app', [prod(0)])],
      nodes: [node(0, 'a'), node(1, 'b'), node(2, 'c')],
      edges: [[dev(1), { to: 2, kind: 'optional' }], [], []],
    });
    expect(devOnly(nested, [1])).toBe(false);
    expect(devOnly(nested, [2])).toBe(false);
  });

  it('an incomplete graph gives no answer', () => {
    expect(devOnly({ ...sharedX(), unresolved: ['a > gone'] }, [1])).toBeNull();
    expect(devOnly({ ...sharedX(), devKnown: false }, [1])).toBeNull();
    expect(devOnly({ ...sharedX(), roots: [] }, [1])).toBeNull();
    expect(devOnly(sharedX(), [])).toBeNull();
  });

  it('an unreachable target gives no answer', () => {
    const g = graph({
      roots: [root('app', [dev(0)])],
      nodes: [node(0, 'a'), node(1, 'orphan')],
    });
    expect(devOnly(g, [0])).toBe(true);
    expect(devOnly(g, [1])).toBeNull();
    expect(devOnly(g, [0, 1])).toBeNull();
    expect(devOnly(g, [99])).toBeNull();
  });

  it("npm's own flag can veto dev-only", () => {
    const g = graph({
      roots: [root('app', [dev(0)])],
      nodes: [node(0, 'a', '1.0.0', false), node(1, 'b', '1.0.0', true)],
      edges: [[prod(1)], []],
    });
    expect(devOnly(g, [1])).toBe(true);
    expect(devOnly(g, [0])).toBe(false);
    expect(devOnly(g, [0, 1])).toBe(false);
  });

  it('a package listed as both a dependency and a devDependency is not dev-only', () => {
    const g = graph({ roots: [root('app', [dev(0), prod(0)])], nodes: [node(0, 'a')] });
    expect(devOnly(g, [0])).toBe(false);
  });
});

describe('cycles and depth', () => {
  it('cycles end', () => {
    const g = graph({
      roots: [root('app', [dev(0)])],
      nodes: [node(0, 'a'), node(1, 'b')],
      edges: [[prod(1)], [prod(0)]],
    });
    expect(devOnly(g, [1])).toBe(true);
    expect(chainsTo(g, [1])).toEqual({
      chains: [
        {
          root: 'app',
          links: [
            { name: 'a', version: '1.0.0' },
            { name: 'b', version: '1.0.0' },
          ],
          dev: true,
        },
      ],
      total: 1,
    });
  });

  it('handles a chain 100,000 levels deep without recursion', () => {
    const depth = 100_000;
    const nodes = Array.from({ length: depth }, (_, i) => node(i, `p${i}`));
    const edges = nodes.map((_, i) => (i + 1 < depth ? [prod(i + 1)] : []));
    const g = graph({ roots: [root('app', [dev(0)])], nodes, edges });
    expect(reachable(g).size).toBe(depth);
    expect(runtimeReachable(g).size).toBe(0);
    expect(devOnly(g, [depth - 1])).toBe(true);
    const result = chainsTo(g, [depth - 1]);
    expect(result.total).toBe(1);
    expect(result.chains).toHaveLength(1);
    expect(result.chains[0]!.links).toHaveLength(depth);
    expect(result.chains[0]!.links[depth - 1]).toEqual({ name: `p${depth - 1}`, version: '1.0.0' });
  });
});

describe('chainsTo', () => {
  it('chainsTo lists the shortest chains', () => {
    const g = graph({
      roots: [root('slack-deck', [prod(0)])],
      nodes: [node(0, 'mkdirp', '0.5.1'), node(1, 'minimist', '0.0.8')],
      edges: [[prod(1)], []],
    });
    expect(chainsTo(g, [1])).toEqual({
      chains: [
        {
          root: 'slack-deck',
          links: [
            { name: 'mkdirp', version: '0.5.1' },
            { name: 'minimist', version: '0.0.8' },
          ],
          dev: false,
        },
      ],
      total: 1,
    });

    // app → p01..p12 → x, listed out of order, plus a longer path app → p01 → q → x
    const names = Array.from({ length: 12 }, (_, i) => `p${String(12 - i).padStart(2, '0')}`);
    const wide = graph({
      roots: [root('app', names.map((_, i) => prod(i)))],
      nodes: [...names.map((name, i) => node(i, name)), node(12, 'x'), node(13, 'q')],
      edges: [...names.map((_, i) => (i === 11 ? [prod(13), prod(12)] : [prod(12)])), [], [prod(12)]],
    });
    const result = chainsTo(wide, [12], 10);
    expect(result.total).toBe(12);
    expect(result.chains).toHaveLength(10);
    expect(result.chains.map((c) => c.links.map((l) => l.name).join(' > '))).toEqual(
      Array.from({ length: 10 }, (_, i) => `p${String(i + 1).padStart(2, '0')} > x`),
    );
  });

  it('orders chains by length, then root order, then link names', () => {
    // app: prod→b, prod→a. web: dev→y, prod→a. a→x, b→x, b→c→y.
    const g = graph({
      roots: [root('app', [prod(1), prod(0)]), root('web', [dev(4), prod(0)])],
      nodes: [node(0, 'a'), node(1, 'b'), node(2, 'c'), node(3, 'x'), node(4, 'y')],
      edges: [[prod(3)], [prod(3), prod(2)], [prod(4)], [], []],
    });
    const result = chainsTo(g, [3, 4]);
    expect(result.total).toBe(4);
    expect(result.chains.map((c) => [c.root, c.links.map((l) => l.name).join(' > '), c.dev])).toEqual([
      ['web', 'y', true],
      ['app', 'a > x', false],
      ['app', 'b > x', false],
      ['web', 'a > x', false],
    ]);
  });

  it('counts each distinct chain once and caps the count at 10,000', () => {
    // A root listing a package twice, and a package listing a dependency twice, is one chain.
    const twice = graph({
      roots: [root('app', [dev(0), prod(0)])],
      nodes: [node(0, 'a'), node(1, 'b')],
      edges: [[prod(1), { to: 1, kind: 'optional' }], []],
    });
    expect(chainsTo(twice, [1, 1])).toEqual({
      chains: [
        {
          root: 'app',
          links: [
            { name: 'a', version: '1.0.0' },
            { name: 'b', version: '1.0.0' },
          ],
          dev: false,
        },
      ],
      total: 1,
    });

    // 20 layers of two packages, each depending on both of the next: 2^20 shortest chains.
    const layers = 20;
    const nodes: DepNode[] = [];
    const layerName = (layer: number, side: string) => `l${String(layer).padStart(2, '0')}${side}`;
    for (let i = 0; i < layers * 2; i++) nodes.push(node(i, layerName(Math.floor(i / 2), i % 2 ? 'b' : 'a')));
    const target = layers * 2;
    nodes.push(node(target, 'x'));
    const edges = nodes.map((_, i) => {
      if (i === target) return [];
      const layer = Math.floor(i / 2);
      return layer + 1 < layers ? [prod(layer * 2 + 2), prod(layer * 2 + 3)] : [prod(target)];
    });
    const g = graph({ roots: [root('app', [prod(0), prod(1)])], nodes, edges });
    const result = chainsTo(g, [target]);
    expect(result.total).toBe(10_000);
    expect(result.chains).toHaveLength(10);
    expect(result.chains[0]!.links.map((l) => l.name)).toEqual([
      ...Array.from({ length: layers }, (_, i) => layerName(i, 'a')),
      'x',
    ]);
  });

  it('gives nothing for unreachable or no targets', () => {
    const g = graph({ roots: [root('app', [prod(0)])], nodes: [node(0, 'a'), node(1, 'orphan')] });
    expect(chainsTo(g, [1])).toEqual({ chains: [], total: 0 });
    expect(chainsTo(g, [])).toEqual({ chains: [], total: 0 });
  });
});

describe('relationshipOf', () => {
  it('relationshipOf tells direct, transitive, and mixed apart', () => {
    // slack-deck: prod→mkdirp→minimist 0.0.8, prod→minimist 1.2.8, dev→jest
    const g = graph({
      roots: [root('slack-deck', [prod(0), prod(2), dev(3)])],
      nodes: [
        node(0, 'mkdirp', '0.5.1'),
        node(1, 'minimist', '0.0.8'),
        node(2, 'minimist', '1.2.8'),
        node(3, 'jest'),
        node(4, 'orphan'),
      ],
      edges: [[prod(1)], [], [], [], []],
    });
    expect(relationshipOf(g, [2])).toBe('direct');
    expect(relationshipOf(g, [3])).toBe('direct');
    expect(relationshipOf(g, [1])).toBe('transitive');
    expect(relationshipOf(g, [1, 2])).toBe('mixed');
    expect(relationshipOf(g, [])).toBeNull();
    expect(relationshipOf(g, [4])).toBeNull();
    expect(relationshipOf(g, [1, 4])).toBe('transitive');
  });
});
