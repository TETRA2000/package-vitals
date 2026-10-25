import { describe, it, expect } from 'vitest';
import { parseNpmLock } from '../../../src/core/lockfiles/npm.js';
import type { PackageJson } from '../../../src/core/lockfiles/package-json.js';
import {
  chainsTo,
  devOnly,
  isComplete,
  type DepGraph,
  type DepRoot,
  type ParseResult,
} from '../../../src/core/lockfiles/graph.js';

const pkg = (version: string, fields: Record<string, unknown> = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/p/-/p-${version}.tgz`,
  ...fields,
});

const packageJson = (fields: Partial<PackageJson>): PackageJson => ({
  name: null,
  dependencies: new Map(),
  devDependencies: new Map(),
  optionalDependencies: new Map(),
  peerDependencies: new Map(),
  scripts: new Map(),
  workspaces: [],
  ...fields,
});

const v3 = (packages: Record<string, unknown>) => JSON.stringify({ lockfileVersion: 3, requires: true, packages });

/** The graph of an `ok` result, checked against the shape every parser keeps. */
function graphOf(r: ParseResult): DepGraph {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}: ${r.message}`);
  const g = r.graph;
  expect(g.edges).toHaveLength(g.nodes.length);
  g.nodes.forEach((n, i) => expect(n.id).toBe(i));
  for (const e of [...g.roots.flatMap((root) => root.edges), ...g.edges.flat()]) {
    expect(Number.isInteger(e.to) && e.to >= 0 && e.to < g.nodes.length).toBe(true);
  }
  return g;
}

const at = (g: DepGraph, id: number) => `${g.nodes[id]!.name}@${g.nodes[id]!.version}`;
const deps = (g: DepGraph, id: number) => g.edges[id]!.map((e) => at(g, e.to));
const rootDeps = (g: DepGraph, root: DepRoot) => root.edges.map((e) => `${e.kind} ${at(g, e.to)}`);

function idOf(g: DepGraph, name: string, version?: string): number {
  const id = g.nodes.findIndex((n) => n.name === name && (version === undefined || n.version === version));
  if (id < 0) throw new Error(`no node ${name}@${version ?? '*'}`);
  return id;
}

describe('parseNpmLock: v2 and v3', () => {
  it('reads a v3 lockfile', () => {
    const g = graphOf(
      parseNpmLock(
        v3({
          '': { name: 'slack-deck', version: '1.0.0', dependencies: { mkdirp: '^0.5.1' }, devDependencies: { jest: '^29.7.0' } },
          'node_modules/jest': pkg('29.7.0', { dev: true }),
          'node_modules/minimist': pkg('0.0.8'),
          'node_modules/mkdirp': pkg('0.5.1', { dependencies: { minimist: '0.0.8' } }),
        }),
        null,
      ),
    );
    expect(g.format).toBe('npm-v3');
    expect(g.roots.map((r) => [r.label, r.path, rootDeps(g, r)])).toEqual([
      ['slack-deck', '.', ['prod mkdirp@0.5.1', 'dev jest@29.7.0']],
    ]);
    expect(chainsTo(g, [idOf(g, 'minimist')])).toEqual({
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
    expect(isComplete(g)).toBe(true);
    expect(g.nodes[idOf(g, 'jest')]).toEqual({ id: 0, name: 'jest', version: '29.7.0', registry: true, lockDev: true });
    expect(devOnly(g, [idOf(g, 'jest')])).toBe(true);
    expect(devOnly(g, [idOf(g, 'minimist')])).toBe(false);
  });

  it('reads a v2 lockfile from packages and ignores its legacy tree', () => {
    const text = JSON.stringify({
      lockfileVersion: 2,
      packages: { '': { dependencies: { a: '^1.0.0' } }, 'node_modules/a': pkg('1.0.0') },
      dependencies: { legacy: { version: '9.9.9' } },
    });
    const g = graphOf(parseNpmLock(text, packageJson({ name: 'from-package-json' })));
    expect(g.format).toBe('npm-v2');
    expect(g.nodes.map((n) => n.name)).toEqual(['a']);
    // The root label falls back to package.json, then to '.'.
    expect(g.roots.map((r) => r.label)).toEqual(['from-package-json']);
    expect(graphOf(parseNpmLock(text, null)).roots.map((r) => r.label)).toEqual(['.']);
  });

  it('resolves nested node_modules before hoisted ones', () => {
    const g = graphOf(
      parseNpmLock(
        v3({
          '': { name: 'app', dependencies: { a: '^1.0.0', x: '^1.0.0', '@s/p': '^1.0.0' } },
          'node_modules/a': pkg('1.0.0', { dependencies: { x: '^2.0.0', b: '^1.0.0' } }),
          'node_modules/a/node_modules/x': pkg('2.0.0'),
          'node_modules/a/node_modules/b': pkg('1.0.0', { dependencies: { x: '^2.0.0', y: '^1.0.0' } }),
          'node_modules/x': pkg('1.0.0'),
          'node_modules/y': pkg('1.0.0'),
          'node_modules/@s/p': pkg('1.0.0', { dependencies: { x: '^1.0.0' } }),
        }),
        null,
      ),
    );
    expect(deps(g, idOf(g, 'a'))).toEqual(['x@2.0.0', 'b@1.0.0']);
    expect(rootDeps(g, g.roots[0]!)).toEqual(['prod a@1.0.0', 'prod x@1.0.0', 'prod @s/p@1.0.0']);
    // b looks in its own node_modules, then a's, then the top level.
    expect(deps(g, idOf(g, 'b'))).toEqual(['x@2.0.0', 'y@1.0.0']);
    expect(deps(g, idOf(g, '@s/p'))).toEqual(['x@1.0.0']);
    expect(isComplete(g)).toBe(true);
  });

  it("reads dev flags, and devOptional isn't dev", () => {
    const g = graphOf(
      parseNpmLock(
        v3({
          '': { name: 'app', dependencies: { shared: '^1.0.0' }, devDependencies: { tool: '^1.0.0', shared: '^1.0.0' } },
          'node_modules/tool': pkg('1.0.0', { dev: true, dependencies: { watcher: '^1.0.0' } }),
          'node_modules/watcher': pkg('1.0.0', { devOptional: true }),
          'node_modules/shared': pkg('1.0.0'),
        }),
        null,
      ),
    );
    expect(g.nodes.map((n) => [n.name, n.lockDev])).toEqual([
      ['tool', true],
      ['watcher', false],
      ['shared', false],
    ]);
    expect(rootDeps(g, g.roots[0]!)).toEqual(['prod shared@1.0.0', 'dev tool@1.0.0', 'dev shared@1.0.0']);
    expect(devOnly(g, [idOf(g, 'tool')])).toBe(true);
    // Only a dev package reaches watcher here, but npm says it's also needed at runtime.
    expect(devOnly(g, [idOf(g, 'watcher')])).toBe(false);
    // Both a dependency and a devDependency.
    expect(devOnly(g, [idOf(g, 'shared')])).toBe(false);
  });

  it('workspaces are roots and links point at them', () => {
    const g = graphOf(
      parseNpmLock(
        v3({
          '': { name: 'mono', workspaces: ['packages/*'], devDependencies: { tool: '^1.0.0' } },
          'node_modules/@mono/lib': { resolved: 'packages/lib', link: true },
          'node_modules/web': { resolved: 'packages/web', link: true },
          'node_modules/left-pad': pkg('1.3.0'),
          'node_modules/tool': pkg('1.0.0', { dev: true }),
          'packages/lib': { name: '@mono/lib', version: '1.0.0', dependencies: { 'left-pad': '^1.3.0' } },
          'packages/web': { version: '0.0.0', dependencies: { '@mono/lib': '*', 'left-pad': '1.0.0' }, devDependencies: { tool: '^1.0.0' } },
          'packages/web/node_modules/left-pad': pkg('1.0.0'),
        }),
        null,
      ),
    );
    // Links aren't packages.
    expect(g.nodes.map((n) => at(g, n.id))).toEqual(['left-pad@1.3.0', 'tool@1.0.0', 'left-pad@1.0.0']);
    expect(g.roots.map((r) => [r.label, r.path, rootDeps(g, r)])).toEqual([
      ['mono', '.', ['dev tool@1.0.0']],
      ['@mono/lib', 'packages/lib', ['prod left-pad@1.3.0']],
      // The edge to @mono/lib is dropped: that workspace is a root of its own.
      ['packages/web', 'packages/web', ['prod left-pad@1.0.0', 'dev tool@1.0.0']],
    ]);
    expect(isComplete(g)).toBe(true);
    expect(devOnly(g, [idOf(g, 'left-pad', '1.3.0')])).toBe(false);
    expect(devOnly(g, [idOf(g, 'tool')])).toBe(true);
  });

  it('an alias keeps its real package name', () => {
    const g = graphOf(
      parseNpmLock(
        v3({
          '': { name: 'app', dependencies: { foo: 'npm:lodash@^4.17.21' } },
          'node_modules/foo': { name: 'lodash', version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
        }),
        null,
      ),
    );
    expect(g.nodes).toEqual([{ id: 0, name: 'lodash', version: '4.17.21', registry: true, lockDev: false }]);
    expect(rootDeps(g, g.roots[0]!)).toEqual(['prod lodash@4.17.21']);
  });

  it('records unresolved required dependencies but not missing optional ones', () => {
    const g = graphOf(
      parseNpmLock(
        v3({
          '': {
            name: 'app',
            dependencies: { a: '^1.0.0', gone: '^1.0.0', ghost: '*' },
            devDependencies: { 'dev-gone': '^1.0.0' },
            optionalDependencies: { fsevents: '^2.3.0' },
            peerDependencies: { react: '*', 'maybe-peer': '*' },
            peerDependenciesMeta: { 'maybe-peer': { optional: true } },
          },
          'node_modules/a': pkg('1.0.0', {
            // npm lists an optional dependency in both maps.
            dependencies: { b: '^1.0.0', 'win-only': '^1.0.0' },
            optionalDependencies: { 'win-only': '^1.0.0' },
            peerDependencies: { 'peer-gone': '*' },
          }),
          // A link whose target isn't in the lockfile.
          'node_modules/ghost': { resolved: 'packages/ghost', link: true },
        }),
        null,
      ),
    );
    expect([...g.unresolved].sort()).toEqual(['a > b', 'a > peer-gone', 'app > dev-gone', 'app > ghost', 'app > gone', 'app > react']);
    expect(rootDeps(g, g.roots[0]!)).toEqual(['prod a@1.0.0']);
    expect(isComplete(g)).toBe(false);
    expect(devOnly(g, [idOf(g, 'a')])).toBeNull();
  });

  it('marks non-registry packages', () => {
    const g = graphOf(
      parseNpmLock(
        v3({
          '': { name: 'app' },
          'node_modules/git': { version: '1.0.0', resolved: 'git+ssh://git@github.com/acme/git.git#0a1b2c3' },
          'node_modules/file': { version: '1.0.0', resolved: 'file:vendor/file-1.0.0.tgz' },
          'node_modules/private': { version: '1.0.0', resolved: 'https://npm.acme.test/private/-/private-1.0.0.tgz' },
          'node_modules/npm': { version: '1.0.0', resolved: 'https://registry.npmjs.org/npm/-/npm-1.0.0.tgz' },
          'node_modules/yarn': { version: '1.0.0', resolved: 'https://registry.yarnpkg.com/yarn/-/yarn-1.0.0.tgz' },
          'node_modules/bundled': { version: '1.0.0', inBundle: true },
        }),
        null,
      ),
    );
    expect(g.nodes.map((n) => [n.name, n.registry])).toEqual([
      ['git', false],
      ['file', false],
      ['private', false],
      ['npm', true],
      ['yarn', true],
      ['bundled', true],
    ]);
  });
});

describe('parseNpmLock: v1', () => {
  const v1 = JSON.stringify({
    name: 'legacy',
    version: '1.0.0',
    lockfileVersion: 1,
    requires: true,
    dependencies: {
      mkdirp: pkg('0.5.1', { requires: { minimist: '0.0.8' }, dependencies: { minimist: pkg('0.0.8') } }),
      minimist: pkg('1.2.8', { dev: true }),
      jest: pkg('29.7.0', {
        dev: true,
        requires: { 'jest-cli': '29.7.0', minimist: '^1.2.0' },
        dependencies: {
          'jest-cli': pkg('29.7.0', { dev: true, requires: { minimist: '^1.2.0', yargs: '^16.0.0' } }),
          yargs: pkg('16.2.0', { dev: true }),
        },
      }),
      yargs: pkg('17.7.2', { dev: true }),
      foo: { version: 'npm:lodash@4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
      bar: { version: 'git+https://github.com/acme/bar.git#0a1b2c3', from: 'git+https://github.com/acme/bar.git' },
    },
  });
  const pj = packageJson({
    name: 'legacy',
    dependencies: new Map([
      ['mkdirp', '^0.5.1'],
      ['foo', 'npm:lodash@^4.17.21'],
      ['bar', 'github:acme/bar'],
    ]),
    devDependencies: new Map([['jest', '^29.7.0']]),
  });

  it('reads a v1 lockfile with package.json', () => {
    const g = graphOf(parseNpmLock(v1, pj));
    expect(g.format).toBe('npm-v1');
    expect(g.roots.map((r) => [r.label, r.path, rootDeps(g, r)])).toEqual([
      [
        'legacy',
        '.',
        ['prod mkdirp@0.5.1', 'prod lodash@4.17.21', 'prod bar@git+https://github.com/acme/bar.git#0a1b2c3', 'dev jest@29.7.0'],
      ],
    ]);
    // Own dependencies first, then each ancestor's, then the top level.
    expect(deps(g, idOf(g, 'mkdirp'))).toEqual(['minimist@0.0.8']);
    expect(deps(g, idOf(g, 'jest'))).toEqual(['jest-cli@29.7.0', 'minimist@1.2.8']);
    expect(deps(g, idOf(g, 'jest-cli'))).toEqual(['minimist@1.2.8', 'yargs@16.2.0']);
    expect(isComplete(g)).toBe(true);
    expect(devOnly(g, [idOf(g, 'minimist', '0.0.8')])).toBe(false);
    expect(devOnly(g, [idOf(g, 'minimist', '1.2.8')])).toBe(true);
    expect(g.nodes.map((n) => [n.name, n.registry, n.lockDev])).toEqual([
      ['mkdirp', true, false],
      ['minimist', true, true],
      ['jest', true, true],
      ['yargs', true, true],
      ['lodash', true, false],
      ['bar', false, false],
      ['minimist', true, false],
      ['jest-cli', true, true],
      ['yargs', true, true],
    ]);
  });

  it('a v1 lockfile without package.json has no roots', () => {
    const g = graphOf(parseNpmLock(v1, null));
    expect(g.roots).toEqual([]);
    expect(g.nodes).toHaveLength(9);
    expect(isComplete(g)).toBe(false);
    expect(devOnly(g, [idOf(g, 'jest')])).toBeNull();
  });

  it('records requires the tree is missing', () => {
    const g = graphOf(
      parseNpmLock(
        JSON.stringify({ lockfileVersion: 1, requires: true, dependencies: { a: pkg('1.0.0', { requires: { b: '^1.0.0' } }) } }),
        packageJson({ name: 'app', dependencies: new Map([['a', '^1.0.0']]), devDependencies: new Map([['c', '^1.0.0']]) }),
      ),
    );
    expect([...g.unresolved].sort()).toEqual(['a > b', 'app > c']);
  });
});

describe('parseNpmLock: hostile and broken files', () => {
  const COULDNT = { status: 'error', message: "Couldn't read this lockfile." };
  const html = '<img src=x onerror=alert(1)>';

  it('reports unsupported versions and broken files without quoting them', () => {
    expect(parseNpmLock(JSON.stringify({ lockfileVersion: 4, packages: {} }), null)).toEqual({
      status: 'unsupported',
      format: 'npm-v4',
      message: 'Unsupported package-lock.json version 4.',
    });
    expect(parseNpmLock('{"lockfileVersion": 3, ', null)).toEqual({ status: 'error', message: 'Not valid JSON.' });
    for (const text of ['[]', '{}', 'null', '"lockfileVersion"', JSON.stringify({ lockfileVersion: html })]) {
      expect(parseNpmLock(text, null)).toEqual({ status: 'error', message: 'Not a package-lock.json file.' });
    }
    // Shapes npm never writes.
    for (const lockfile of [
      { lockfileVersion: 3 },
      { lockfileVersion: 3, packages: { 'node_modules/a': pkg('1.0.0') } },
      { lockfileVersion: 3, packages: { '': { dependencies: html } } },
      { lockfileVersion: 3, packages: { '': { dependencies: { a: 1 } } } },
      { lockfileVersion: 3, packages: { '': {}, 'node_modules/a': html } },
      { lockfileVersion: 1, dependencies: { a: { version: '1.0.0', requires: [html] } } },
      { lockfileVersion: 1, dependencies: html },
    ]) {
      expect(parseNpmLock(JSON.stringify(lockfile), null)).toEqual(COULDNT);
    }
  });

  it('survives hostile names and deep nesting', () => {
    const before = Object.getOwnPropertyNames(Object.prototype);

    const g = graphOf(
      parseNpmLock(
        '{"lockfileVersion": 3, "packages": {' +
          '"": {"name": "app", "dependencies": {"__proto__": "1.0.0", "constructor": "2.0.0", "hasOwnProperty": "1.0.0"}},' +
          '"node_modules/__proto__": {"version": "1.0.0", "__proto__": {"dev": true}, "dependencies": {"constructor": "2.0.0"}},' +
          '"node_modules/constructor": {"version": "2.0.0", "dependencies": {"__proto__": "1.0.0", "toString": "1.0.0"}}}}',
        null,
      ),
    );
    expect(g.nodes.map((n) => [n.name, n.lockDev])).toEqual([
      ['__proto__', false],
      ['constructor', false],
    ]);
    expect(rootDeps(g, g.roots[0]!)).toEqual(['prod __proto__@1.0.0', 'prod constructor@2.0.0']);
    // A cycle, and names that only Object.prototype has stay unresolved.
    expect(deps(g, 0)).toEqual(['constructor@2.0.0']);
    expect(deps(g, 1)).toEqual(['__proto__@1.0.0']);
    expect([...g.unresolved].sort()).toEqual(['app > hasOwnProperty', 'constructor > toString']);

    const legacy = graphOf(
      parseNpmLock(
        '{"lockfileVersion": 1, "dependencies": {"__proto__": {"version": "1.0.0", "requires": {"constructor": "1.0.0"}}, "constructor": {"version": "1.0.0"}}}',
        packageJson({ name: 'app', dependencies: new Map([['__proto__', '1.0.0'], ['valueOf', '1.0.0']]) }),
      ),
    );
    expect(rootDeps(legacy, legacy.roots[0]!)).toEqual(['prod __proto__@1.0.0']);
    expect(deps(legacy, 0)).toEqual(['constructor@1.0.0']);
    expect(legacy.unresolved).toEqual(['app > valueOf']);

    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(before);
    expect(({} as Record<string, unknown>).dev).toBeUndefined();

    // v1, nested 100,000 levels deep. JSON.stringify itself can't go that deep, so the text is built directly.
    const depth = 100_000;
    const level = '{"a": {"version": "1.0.0", "requires": {"a": "1.0.0"}, "dependencies": ';
    const deep = `{"lockfileVersion": 1, "requires": true, "dependencies": ${level.repeat(depth)}{}${'}}'.repeat(depth)}}`;
    const r = parseNpmLock(deep, packageJson({ name: 'app', dependencies: new Map([['a', '1.0.0']]) }));
    expect(['ok', 'error']).toContain(r.status);
    if (r.status === 'ok') expect(r.graph.nodes).toHaveLength(depth);
    else expect(r).toEqual(COULDNT);

    // v3, one package 100,000 levels deep, which looks up a hoisted dependency.
    const deepKey = Array.from({ length: depth }, () => 'node_modules/a').join('/');
    const flat = graphOf(
      parseNpmLock(
        v3({
          '': { name: 'app', dependencies: { a: '1.0.0' } },
          'node_modules/a': pkg('1.0.0'),
          'node_modules/b': pkg('1.0.0'),
          [deepKey]: pkg('9.0.0', { dependencies: { b: '1.0.0' } }),
        }),
        null,
      ),
    );
    expect(deps(flat, idOf(flat, 'a', '9.0.0'))).toEqual(['b@1.0.0']);
  });
});
