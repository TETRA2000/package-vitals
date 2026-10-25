import { describe, it, expect, vi } from 'vitest';
import { parsePnpmLock } from '../../../src/core/lockfiles/pnpm.js';
import { chainsTo, devOnly, isComplete, type DepGraph, type DepRoot, type ParseResult } from '../../../src/core/lockfiles/graph.js';

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
const deps = (g: DepGraph, id: number) => g.edges[id]!.map((e) => `${e.kind} ${at(g, e.to)}`);
const rootDeps = (g: DepGraph, root: DepRoot) => root.edges.map((e) => `${e.kind} ${at(g, e.to)}`);

function idOf(g: DepGraph, name: string, version?: string): number {
  const id = g.nodes.findIndex((n) => n.name === name && (version === undefined || n.version === version));
  if (id < 0) throw new Error(`no node ${name}@${version ?? '*'}`);
  return id;
}

const lock = (body: string) => `lockfileVersion: '9.0'\n${body}`;
const error = (message: string) => ({ status: 'error', message });

const APP = lock(`
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@babel/core':
        specifier: ^7.24.0
        version: 7.24.0
      vite:
        specifier: ^5.0.0
        version: 5.0.0(@types/node@20.0.0)
    devDependencies:
      '@types/node':
        specifier: ^20.0.0
        version: 20.0.0
      typescript:
        specifier: ^5.4.0
        version: 5.4.0
    optionalDependencies:
      fsevents:
        specifier: ^2.3.0
        version: 2.3.3

packages:

  '@babel/core@7.24.0':
    resolution: {integrity: sha512-aaa}
    engines: {node: '>=6.9.0'}

  '@types/node@20.0.0':
    resolution: {integrity: sha512-bbb}

  esbuild@0.19.0:
    resolution: {integrity: sha512-ccc}
    hasBin: true

  fsevents@2.3.3:
    resolution: {integrity: sha512-ddd}
    os: [darwin]

  typescript@5.4.0:
    resolution: {integrity: sha512-eee}

  vite@5.0.0:
    resolution: {integrity: sha512-fff}
    peerDependencies:
      '@types/node': ^18.0.0 || >=20.0.0
    peerDependenciesMeta:
      '@types/node':
        optional: true

snapshots:

  '@babel/core@7.24.0': {}

  '@types/node@20.0.0': {}

  esbuild@0.19.0: {}

  fsevents@2.3.3:
    optional: true

  typescript@5.4.0: {}

  vite@5.0.0(@types/node@20.0.0):
    dependencies:
      '@types/node': 20.0.0
      esbuild: 0.19.0
    optionalDependencies:
      fsevents: 2.3.3
    transitivePeerDependencies:
      - supports-color
`);

describe('parsePnpmLock', () => {
  it('reads importers, snapshots, and peer suffixes', () => {
    const g = graphOf(parsePnpmLock(APP));
    expect(g.format).toBe('pnpm-v9');
    expect(g.nodes.map((n) => [n.name, n.version, n.registry, n.lockDev])).toEqual([
      ['@babel/core', '7.24.0', true, null],
      ['@types/node', '20.0.0', true, null],
      ['esbuild', '0.19.0', true, null],
      ['fsevents', '2.3.3', true, null],
      ['typescript', '5.4.0', true, null],
      ['vite', '5.0.0', true, null],
    ]);
    expect(g.roots.map((r) => [r.label, r.path])).toEqual([['.', '.']]);
    expect(rootDeps(g, g.roots[0]!)).toEqual([
      'prod @babel/core@7.24.0',
      'prod vite@5.0.0',
      'dev @types/node@20.0.0',
      'dev typescript@5.4.0',
      'optional fsevents@2.3.3',
    ]);
    expect(deps(g, idOf(g, 'vite'))).toEqual(['prod @types/node@20.0.0', 'prod esbuild@0.19.0', 'optional fsevents@2.3.3']);
    expect(g.unresolved).toEqual([]);
    expect(g.devKnown).toBe(true);
    expect(isComplete(g)).toBe(true);
    expect(devOnly(g, [idOf(g, 'typescript')])).toBe(true);
    // A dev dependency of the root that vite also depends on ships.
    expect(devOnly(g, [idOf(g, '@types/node')])).toBe(false);
    expect(chainsTo(g, [idOf(g, 'esbuild')]).chains).toEqual([
      {
        root: '.',
        links: [
          { name: 'vite', version: '5.0.0' },
          { name: 'esbuild', version: '0.19.0' },
        ],
        dev: false,
      },
    ]);
  });

  it('workspace importers are roots, and link: dependencies are dropped', () => {
    const g = graphOf(
      parsePnpmLock(
        lock(`
importers:
  .:
    devDependencies:
      jest:
        specifier: ^29.0.0
        version: 29.0.0
  packages/app:
    dependencies:
      lib:
        specifier: workspace:*
        version: link:../lib
      react:
        specifier: ^18.0.0
        version: 18.0.0
  packages/lib:
    dependencies:
      chalk:
        specifier: ^4.0.0
        version: 4.1.0
snapshots:
  chalk@4.1.0: {}
  jest@29.0.0:
    dependencies:
      chalk: 4.1.0
      local-thing: link:../somewhere
  react@18.0.0: {}
`),
      ),
    );
    expect(g.roots.map((r) => [r.label, r.path, rootDeps(g, r)])).toEqual([
      ['.', '.', ['dev jest@29.0.0']],
      ['packages/app', 'packages/app', ['prod react@18.0.0']],
      ['packages/lib', 'packages/lib', ['prod chalk@4.1.0']],
    ]);
    expect(deps(g, idOf(g, 'jest'))).toEqual(['prod chalk@4.1.0']);
    expect(g.unresolved).toEqual([]);
    expect(isComplete(g)).toBe(true);
    expect(devOnly(g, [idOf(g, 'jest')])).toBe(true);
    expect(devOnly(g, [idOf(g, 'chalk')])).toBe(false);
  });

  it('aliases resolve to the real package', () => {
    const g = graphOf(
      parsePnpmLock(
        lock(`
importers:
  .:
    dependencies:
      string-width-cjs:
        specifier: npm:string-width@^4.2.0
        version: string-width@4.2.3
      string-width:
        specifier: ^5.1.2
        version: 5.1.2
      real-alias:
        specifier: npm:@scope/real@^1.0.0
        version: '@scope/real@1.0.0'
      peer-alias:
        specifier: npm:plugin@^2.0.0
        version: plugin@2.0.0(@scope/real@1.0.0)
snapshots:
  string-width@4.2.3: {}
  string-width@5.1.2:
    dependencies:
      strip-ansi-cjs: strip-ansi@6.0.1
  strip-ansi@6.0.1: {}
  '@scope/real@1.0.0': {}
  plugin@2.0.0(@scope/real@1.0.0):
    dependencies:
      '@scope/real': 1.0.0
`),
      ),
    );
    expect(rootDeps(g, g.roots[0]!)).toEqual([
      'prod string-width@4.2.3',
      'prod string-width@5.1.2',
      'prod @scope/real@1.0.0',
      'prod plugin@2.0.0',
    ]);
    expect(deps(g, idOf(g, 'string-width', '5.1.2'))).toEqual(['prod strip-ansi@6.0.1']);
    expect(deps(g, idOf(g, 'plugin'))).toEqual(['prod @scope/real@1.0.0']);
    expect(g.unresolved).toEqual([]);
  });

  it('git, tarball, and file versions with an @ are not aliases', () => {
    const g = graphOf(
      parsePnpmLock(
        lock(`
importers:
  .:
    dependencies:
      foo:
        specifier: git+ssh://git@github.com/o/foo.git
        version: git+ssh://git@github.com/o/foo.git#abc
packages:
  foo@git+ssh://git@github.com/o/foo.git#abc:
    resolution: {commit: abc, repo: 'git@github.com:o/foo.git', type: git}
    version: 1.0.0
  bar@https://user@codeload.github.com/o/bar/tar.gz/def:
    resolution: {tarball: 'https://user@codeload.github.com/o/bar/tar.gz/def'}
    version: 1.0.0
  baz@file:../pkg@x:
    resolution: {directory: ../pkg@x, type: directory}
    version: 1.0.0
snapshots:
  foo@git+ssh://git@github.com/o/foo.git#abc:
    dependencies:
      bar: https://user@codeload.github.com/o/bar/tar.gz/def
      baz: file:../pkg@x
  bar@https://user@codeload.github.com/o/bar/tar.gz/def: {}
  baz@file:../pkg@x: {}
`),
      ),
    );
    expect(g.nodes.map((n) => [n.name, n.version, n.registry])).toEqual([
      ['foo', 'git+ssh://git@github.com/o/foo.git#abc', false],
      ['bar', 'https://user@codeload.github.com/o/bar/tar.gz/def', false],
      ['baz', 'file:../pkg@x', false],
    ]);
    expect(g.roots[0]!.edges).toEqual([{ to: 0, kind: 'prod' }]);
    expect(g.edges[0]).toEqual([
      { to: 1, kind: 'prod' },
      { to: 2, kind: 'prod' },
    ]);
    expect(g.unresolved).toEqual([]);
    expect(isComplete(g)).toBe(true);
  });

  it('registry comes from the packages entry', () => {
    const g = graphOf(
      parsePnpmLock(
        lock(`
packages:
  a@1.0.0:
    resolution: {integrity: sha512-a}
  b@1.0.0:
    resolution: {integrity: sha512-b, tarball: https://example.com/b.tgz}
  c@https://codeload.github.com/u/c/tar.gz/abc:
    resolution: {tarball: https://codeload.github.com/u/c/tar.gz/abc}
    version: 1.0.0
  d@git+https://github.com/u/d.git#abc:
    resolution: {commit: abc, repo: https://github.com/u/d.git, type: git}
    version: 1.0.0
  e@file:../e:
    resolution: {directory: ../e, type: directory}
  g@1.0.0:
    resolution: {integrity: sha512-g}
  h@1.0.0:
    resolution: integrity
snapshots:
  a@1.0.0: {}
  b@1.0.0: {}
  c@https://codeload.github.com/u/c/tar.gz/abc: {}
  d@git+https://github.com/u/d.git#abc: {}
  e@file:../e: {}
  f@1.0.0: {}
  g@1.0.0(a@1.0.0): {}
  h@1.0.0: {}
`),
      ),
    );
    expect(g.nodes.map((n) => [n.name, n.version, n.registry])).toEqual([
      ['a', '1.0.0', true],
      ['b', '1.0.0', false],
      ['c', 'https://codeload.github.com/u/c/tar.gz/abc', false],
      ['d', 'git+https://github.com/u/d.git#abc', false],
      ['e', 'file:../e', false],
      ['f', '1.0.0', false],
      ['g', '1.0.0', true],
      ['h', '1.0.0', false],
    ]);
  });

  it('records unresolved required dependencies and skips missing optional ones', () => {
    const g = graphOf(
      parsePnpmLock(
        lock(`
importers:
  .:
    dependencies:
      a:
        specifier: ^1.0.0
        version: 1.0.0
      z:
        specifier: ^1.0.0
        version: 1.0.0
    devDependencies:
      y:
        specifier: ^1.0.0
        version: 1.0.0
    optionalDependencies:
      gone:
        specifier: ^1.0.0
        version: 1.0.0
snapshots:
  a@1.0.0:
    dependencies:
      b: 2.0.0
      w: x@1.0.0
    optionalDependencies:
      c: 1.0.0
`),
      ),
    );
    expect(g.unresolved).toEqual(['. > z', '. > y', 'a > b', 'a > w']);
    expect(isComplete(g)).toBe(false);
    expect(devOnly(g, [idOf(g, 'a')])).toBeNull();
  });

  it('without importers there are no roots, and without snapshots no nodes', () => {
    const noImporters = graphOf(parsePnpmLock(lock('snapshots:\n  a@1.0.0: {}\n')));
    expect(noImporters.roots).toEqual([]);
    expect(noImporters.nodes.map((n) => n.name)).toEqual(['a']);
    expect(isComplete(noImporters)).toBe(false);

    const noSnapshots = graphOf(
      parsePnpmLock(lock('importers:\n  .:\n    dependencies:\n      a:\n        specifier: ^1.0.0\n        version: 1.0.0\n')),
    );
    expect(noSnapshots.nodes).toEqual([]);
    expect(noSnapshots.unresolved).toEqual(['. > a']);

    const empty = graphOf(parsePnpmLock(lock('importers:\n  .: {}\n')));
    expect(empty.roots).toEqual([{ label: '.', path: '.', edges: [] }]);
    expect(isComplete(empty)).toBe(true);
  });

  it('older lockfile versions are unsupported', () => {
    expect(parsePnpmLock("lockfileVersion: '6.0'\nimporters: {}\n")).toEqual({
      status: 'unsupported',
      format: 'pnpm-v6.0',
      message: "pnpm lockfile version 6.0 isn't supported yet.",
    });
    expect(parsePnpmLock('lockfileVersion: 5.4\n')).toEqual({
      status: 'unsupported',
      format: 'pnpm-v5.4',
      message: "pnpm lockfile version 5.4 isn't supported yet.",
    });
    expect(parsePnpmLock("lockfileVersion: '5.4.2'\n")).toMatchObject({ format: 'pnpm-v5.4.2' });
    expect(graphOf(parsePnpmLock('lockfileVersion: 9\n')).format).toBe('pnpm-v9');
    expect(graphOf(parsePnpmLock('lockfileVersion: 9.0\n')).format).toBe('pnpm-v9');
  });

  it("a version that doesn't look like one is never quoted", () => {
    const unknown = {
      status: 'unsupported',
      format: 'pnpm-unknown',
      message: "This pnpm lockfile version isn't supported yet.",
    };
    expect(parsePnpmLock("lockfileVersion: '<img src=x>'\n")).toEqual(unknown);
    expect(parsePnpmLock(`lockfileVersion: '${'9'.repeat(5000)}'\n`)).toEqual(unknown);
    expect(parsePnpmLock("lockfileVersion: '6.0\n\n  more'\n")).toEqual(unknown);
    expect(parsePnpmLock("lockfileVersion: '1.2.3.4'\n")).toEqual(unknown);
    expect(parsePnpmLock("lockfileVersion: '1000'\n")).toEqual(unknown);
    expect(parsePnpmLock("lockfileVersion: ' 6.0'\n")).toEqual(unknown);
    expect(parsePnpmLock('lockfileVersion: -1\n')).toEqual(unknown);
    expect(parsePnpmLock('lockfileVersion: 1e21\n')).toEqual(unknown);
    expect(parsePnpmLock('lockfileVersion: .nan\n')).toEqual(unknown);
    expect(parsePnpmLock('lockfileVersion: [9]\n')).toEqual(unknown);
    expect(parsePnpmLock('lockfileVersion: true\n')).toEqual(unknown);
  });

  it('files that are not pnpm lockfiles', () => {
    const notPnpm = error('Not a pnpm-lock.yaml file.');
    expect(parsePnpmLock('')).toEqual(notPnpm);
    expect(parsePnpmLock('- a\n- b\n')).toEqual(notPnpm);
    expect(parsePnpmLock('just text\n')).toEqual(notPnpm);
    expect(parsePnpmLock('importers: {}\n')).toEqual(notPnpm);
    expect(parsePnpmLock('lockfileVersion:\n')).toEqual(notPnpm);
  });

  it('invalid YAML, an alias bomb, and __proto__ keys', () => {
    const invalid = error('Not valid YAML.');
    expect(parsePnpmLock("lockfileVersion: '9.0'\nimporters: [a, b\n")).toEqual(invalid);
    expect(parsePnpmLock("lockfileVersion: '9.0'\nlockfileVersion: '9.0'\n")).toEqual(invalid);
    expect(parsePnpmLock("lockfileVersion: '9.0'\n---\nlockfileVersion: '9.0'\n")).toEqual(invalid);

    const bomb = [lock('a0: &a0 [x, x, x, x, x, x, x, x, x, x]')];
    for (let i = 1; i < 10; i++) bomb.push(`a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(', ')}]`);
    const started = performance.now();
    expect(parsePnpmLock(bomb.join('\n') + '\n')).toEqual(invalid);
    expect(performance.now() - started).toBeLessThan(1000);

    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const g = graphOf(
      parsePnpmLock(
        lock(`
importers:
  __proto__:
    dependencies:
      constructor:
        specifier: ^1.0.0
        version: 1.0.0
      toString:
        specifier: ^1.0.0
        version: 1.0.0
snapshots:
  constructor@1.0.0:
    dependencies:
      __proto__: 1.0.0
  __proto__@1.0.0: {}
`),
      ),
    );
    expect(g.roots.map((r) => [r.label, rootDeps(g, r)])).toEqual([['__proto__', ['prod constructor@1.0.0']]]);
    expect(deps(g, idOf(g, 'constructor'))).toEqual(['prod __proto__@1.0.0']);
    expect(g.unresolved).toEqual(['__proto__ > toString']);
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect(({} as Record<string, unknown>)['dependencies']).toBeUndefined();
  });

  it('a repeated or complex key in any mapping is invalid YAML', () => {
    const invalid = error('Not valid YAML.');
    expect(parsePnpmLock(lock('snapshots:\n  a@1.0.0: {}\n  b@1.0.0: {}\n  a@1.0.0: {}\n'))).toEqual(invalid);
    expect(
      parsePnpmLock(lock("importers:\n  .:\n    dependencies: {}\n    devDependencies: {}\n    'dependencies': {}\n")),
    ).toEqual(invalid);
    // A JS object can't tell these apart, so the second would silently replace the first.
    expect(parsePnpmLock(lock("importers:\n  1: {}\n  '1': {}\n"))).toEqual(invalid);
    expect(parsePnpmLock(lock('importers:\n  ? [a]\n  : {}\n'))).toEqual(invalid);
    expect(parsePnpmLock(lock('x: [{a: 1, a: 2}]\n'))).toEqual(invalid);
  });

  it('deep nesting and odd tags neither throw nor reach the process', () => {
    const warn = vi.spyOn(process, 'emitWarning');
    try {
      expect(parsePnpmLock('a: ' + '['.repeat(50000) + ']'.repeat(50000))).toEqual(error('Not valid YAML.'));
      expect(graphOf(parsePnpmLock(lock('x: !odd%1B value\n'))).nodes).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('shapes pnpm never writes fall back to the generic error', () => {
    const generic = error("Couldn't read this lockfile.");
    expect(parsePnpmLock(lock('importers: [a]\n'))).toEqual(generic);
    expect(parsePnpmLock(lock('snapshots: text\n'))).toEqual(generic);
    expect(parsePnpmLock(lock('importers:\n  .: text\n'))).toEqual(generic);
    expect(parsePnpmLock(lock('importers:\n  .:\n    dependencies: [a]\n'))).toEqual(generic);
    expect(parsePnpmLock(lock('importers:\n  .:\n    dependencies:\n      a: 1.0.0\n'))).toEqual(generic);
    expect(parsePnpmLock(lock('importers:\n  .:\n    dependencies:\n      a: {specifier: ^1.0.0}\n'))).toEqual(generic);
    expect(parsePnpmLock(lock('snapshots:\n  a: {}\n'))).toEqual(generic);
    expect(parsePnpmLock(lock("snapshots:\n  '@a': {}\n"))).toEqual(generic);
    expect(parsePnpmLock(lock('snapshots:\n  a@: {}\n'))).toEqual(generic);
    expect(parsePnpmLock(lock('snapshots:\n  a@1.0.0: text\n'))).toEqual(generic);
    expect(parsePnpmLock(lock('snapshots:\n  a@1.0.0:\n    dependencies:\n      b: {version: 1.0.0}\n'))).toEqual(generic);
    // YAML 1.1 can make a Map or a Set, which would otherwise read as no dependencies at all.
    const yaml11 = (deps: string) =>
      `%YAML 1.1\n---\n${lock(`importers:\n  .:\n    dependencies: ${deps}\nsnapshots:\n  a@1.0.0: {}\n`)}`;
    expect(parsePnpmLock(yaml11('!!omap [{a: {specifier: ^1.0.0, version: 1.0.0}}]'))).toEqual(generic);
    expect(parsePnpmLock(yaml11('!!set {a}'))).toEqual(generic);
    expect(graphOf(parsePnpmLock(yaml11('{a: {specifier: ^1.0.0, version: 1.0.0}}'))).roots[0]!.edges).toEqual([
      { to: 0, kind: 'prod' },
    ]);
  });

  it('a YAML alias, which pnpm never writes, is invalid YAML', () => {
    const invalid = error('Not valid YAML.');
    const r = parsePnpmLock(
      lock(`
snapshots:
  a@1.0.0:
    dependencies: &d
      c: 1.0.0
  b@1.0.0:
    dependencies: *d
  c@1.0.0: {}
`),
    );
    expect(r).toEqual(invalid);
    expect(parsePnpmLock(lock('x: &a 1\ny: *a\n'))).toEqual(invalid);
    // An anchor alone resolves nothing and is harmless.
    expect(graphOf(parsePnpmLock(lock('snapshots:\n  a@1.0.0: &a {}\n'))).nodes.map((n) => n.name)).toEqual(['a']);
  });

  it('many aliases are refused before any of them is resolved', () => {
    const invalid = error('Not valid YAML.');
    // Each pair redefines the anchor and uses it once, so no alias count is ever exceeded.
    let started = performance.now();
    expect(parsePnpmLock(lock('x:\n' + '  - &a x\n  - *a\n'.repeat(40000)))).toEqual(invalid);
    expect(performance.now() - started).toBeLessThan(1000);

    // An anchor on a list of empty lists counts as holding no aliases, so the count never fires either.
    started = performance.now();
    expect(parsePnpmLock(lock(`a: &a [${'[], '.repeat(16000)}[]]\nb: [${'*a, '.repeat(8000)}*a]\n`))).toEqual(invalid);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('reads a large lockfile', () => {
    let body = 'importers:\n  .:\n    dependencies:\n      p0:\n        specifier: ^1.0.0\n        version: 1.0.0\nsnapshots:\n';
    for (let i = 0; i < 20000; i++) body += `  p${i}@1.0.0:\n    dependencies:\n      p${i + 1}: 1.0.0\n`;
    const started = performance.now();
    const r = parsePnpmLock(lock(body));
    expect(performance.now() - started).toBeLessThan(2000);
    const g = graphOf(r);
    expect(g.nodes).toHaveLength(20000);
    expect(g.unresolved).toEqual(['p19999 > p20000']);
  });
});
