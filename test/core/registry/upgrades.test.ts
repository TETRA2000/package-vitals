import { describe, it, expect } from 'vitest';
import type { DepGraph } from '../../../src/core/lockfiles/graph.js';
import { isOutdated, planDirectUpgrades } from '../../../src/core/registry/upgrades.js';
import type { RegistryVersion } from '../../../src/core/registry/registry.js';

const v = (version: string, dependencies: string[] = [], deprecated = false): RegistryVersion => ({ version, dependencies, deprecated });

/** `specs`: [name, version, children (indices)]; `direct`: indices the single root declares. */
function graph(specs: [string, string, number[]][], direct: number[]): DepGraph {
  return {
    format: 'npm-v3',
    roots: [{ label: 'app', path: 'package.json', edges: direct.map((to) => ({ to, kind: 'prod' as const })) }],
    nodes: specs.map(([name, version], id) => ({ id, name, version, registry: true, lockDev: null })),
    edges: specs.map(([, , kids]) => kids.map((to) => ({ to, kind: 'prod' as const }))),
    unresolved: [],
    devKnown: true,
  };
}

describe('isOutdated', () => {
  it('compares versions', () => {
    expect(isOutdated('npm', '0.5.1', '3.0.1')).toBe(true);
    expect(isOutdated('npm', '3.0.1', '3.0.1')).toBe(false);
    expect(isOutdated('npm', '4.0.0', '3.0.1')).toBe(false);
    expect(isOutdated('npm', 'git+ssh://x', '1.0.0')).toBeNull();
    expect(isOutdated('rubygems', '1.19.3', '1.19.4')).toBe(true);
    expect(isOutdated('rubygems', '1.19.4', '1.19.4')).toBe(false);
  });
});

describe('planDirectUpgrades', () => {
  const MKDIRP = [v('0.5.1', ['minimist'], true), v('0.5.6', ['minimist']), v('1.0.0')];

  it('suggests the lowest release that drops the dependency', () => {
    const g = graph([['mkdirp', '0.5.1', [1]], ['minimist', '0.0.8', []]], [0]);
    const plan = planDirectUpgrades('npm', g, [1], (n) => (n === 'mkdirp' ? MKDIRP : null));
    expect(plan).toEqual([{ name: 'mkdirp', from: '0.5.1', to: '1.0.0' }]);
  });

  it('follows deeper chains', () => {
    const g = graph([['a', '1.0.0', [1]], ['b', '1.0.0', [2]], ['x', '1.0.0', []]], [0]);
    const plan = planDirectUpgrades('npm', g, [2], () => [v('1.0.0', ['b']), v('1.5.0', ['b']), v('1.6.0-beta.1'), v('1.7.0', [], true), v('2.0.0')]);
    expect(plan).toEqual([{ name: 'a', from: '1.0.0', to: '2.0.0' }]);
  });

  it('returns null when the package is also direct', () => {
    const g = graph([['a', '1.0.0', [1]], ['x', '1.0.0', []]], [0, 1]);
    expect(planDirectUpgrades('npm', g, [1], () => [v('2.0.0')])).toBeNull();
  });

  it('returns null when another chain keeps it', () => {
    // a -> x and c -> x; only a can be upgraded.
    const g = graph([['a', '1.0.0', [2]], ['c', '1.0.0', [2]], ['x', '1.0.0', []]], [0, 1]);
    expect(planDirectUpgrades('npm', g, [2], (n) => (n === 'a' ? [v('2.0.0')] : [v('1.0.0', ['x'])]))).toBeNull();
    // Both can be upgraded: both are listed, sorted by name.
    expect(planDirectUpgrades('npm', g, [2], (n) => (n === 'a' ? [v('2.0.0')] : [v('3.0.0')]))).toEqual([
      { name: 'a', from: '1.0.0', to: '2.0.0' },
      { name: 'c', from: '1.0.0', to: '3.0.0' },
    ]);
  });

  it('returns null when no release drops it, or nothing can be compared or fetched', () => {
    const g = graph([['mkdirp', '0.5.1', [1]], ['minimist', '0.0.8', []]], [0]);
    expect(planDirectUpgrades('npm', g, [1], () => [v('0.5.1', ['minimist']), v('0.9.0', ['minimist'])])).toBeNull();
    expect(planDirectUpgrades('npm', g, [1], () => null)).toBeNull();
    expect(planDirectUpgrades('npm', g, [1], () => [v('1.0.0', [], true)])).toBeNull();
    const odd = graph([['mkdirp', 'git+ssh://x', [1]], ['minimist', '0.0.8', []]], [0]);
    expect(planDirectUpgrades('npm', odd, [1], () => MKDIRP)).toBeNull();
    expect(planDirectUpgrades('npm', graph([['a', '1.0.0', []], ['x', '1.0.0', []]], [0]), [1], () => MKDIRP)).toBeNull();
  });

  it('handles one package locked at two versions, deduplicating equal upgrades', () => {
    const g = graph(
      [['a', '1.0.0', [2]], ['a', '1.0.0', [2]], ['x', '1.0.0', []]],
      [0, 1],
    );
    expect(planDirectUpgrades('npm', g, [2], () => [v('2.0.0')])).toEqual([{ name: 'a', from: '1.0.0', to: '2.0.0' }]);
  });
});
