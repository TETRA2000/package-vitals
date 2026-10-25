import { describe, it, expect } from 'vitest';
import { readPackageJson, type PackageJson } from '../../../src/core/lockfiles/package-json.js';

const read = (fields: Record<string, unknown>) => readPackageJson(JSON.stringify(fields));

const empty: PackageJson = {
  name: null,
  dependencies: new Map(),
  devDependencies: new Map(),
  optionalDependencies: new Map(),
  peerDependencies: new Map(),
  scripts: new Map(),
  workspaces: [],
};

describe('readPackageJson', () => {
  it('reads dependencies, scripts, and both workspaces forms', () => {
    expect(
      read({
        name: 'web',
        dependencies: { react: '^19.0.0' },
        devDependencies: { vite: '^8.0.0', vitest: '^5.0.0' },
        optionalDependencies: { fsevents: '^2.3.0' },
        peerDependencies: { 'react-dom': '*' },
        scripts: { build: 'vite build', test: 'vitest run' },
        workspaces: ['packages/*', 'apps/**'],
      }),
    ).toEqual({
      name: 'web',
      dependencies: new Map([['react', '^19.0.0']]),
      devDependencies: new Map([
        ['vite', '^8.0.0'],
        ['vitest', '^5.0.0'],
      ]),
      optionalDependencies: new Map([['fsevents', '^2.3.0']]),
      peerDependencies: new Map([['react-dom', '*']]),
      scripts: new Map([
        ['build', 'vite build'],
        ['test', 'vitest run'],
      ]),
      workspaces: ['packages/*', 'apps/**'],
    });
    expect(read({ workspaces: { packages: ['packages/*'], nohoist: ['**/react'] } })?.workspaces).toEqual(['packages/*']);
  });

  it('treats missing and malformed fields as empty', () => {
    expect(read({})).toEqual(empty);
    expect(
      read({
        name: 7,
        dependencies: ['react'],
        devDependencies: 'vite',
        scripts: { build: 'vite build', bad: 1, worse: null },
        workspaces: ['packages/*', 3, { a: 1 }],
      }),
    ).toEqual({ ...empty, scripts: new Map([['build', 'vite build']]), workspaces: ['packages/*'] });
    expect(read({ workspaces: { packages: 'packages/*' } })?.workspaces).toEqual([]);
  });

  it('returns null for anything but a JSON object', () => {
    for (const text of ['[]', '1', '{', 'null', '"package.json"', '']) expect(readPackageJson(text)).toBeNull();
  });

  it('keeps dependencies named __proto__ and constructor', () => {
    const before = Object.getOwnPropertyNames(Object.prototype);
    const pj = readPackageJson(
      '{"__proto__": {"polluted": "yes"}, "dependencies": {"__proto__": "1.0.0", "constructor": "2.0.0", "toString": "3.0.0"}}',
    );
    expect([...pj!.dependencies]).toEqual([
      ['__proto__', '1.0.0'],
      ['constructor', '2.0.0'],
      ['toString', '3.0.0'],
    ]);
    expect(pj!.devDependencies.size).toBe(0);
    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // A field named like an Object.prototype member is read only when the file has it.
    expect(readPackageJson('{"constructor": {"a": "1"}}')).toEqual(empty);
  });
});
