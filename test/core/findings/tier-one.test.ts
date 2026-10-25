import { describe, it, expect } from 'vitest';
import { tierOne } from '../../../src/core/findings/tier-one.js';

type Input = Parameters<typeof tierOne>[0];

const npmDevOnly: Input = { ecosystem: 'npm', scope: 'development', lockfileRead: true, lockfileDevOnly: true, jsBundler: null };
const gemsNotRead: Input = { ecosystem: 'rubygems', scope: 'development', lockfileRead: false, lockfileDevOnly: null, jsBundler: null };

const rows: [string, Input, 'not_shipped' | null][] = [
  ['npm, read, dev-only, no bundler, scope development', npmDevOnly, 'not_shipped'],
  ['the same with scope null (an OSV-only finding)', { ...npmDevOnly, scope: null }, 'not_shipped'],
  ['npm with a bundler', { ...npmDevOnly, jsBundler: 'vite (dependency)' }, null],
  ['npm with the bundler question left open', { ...npmDevOnly, jsBundler: "unknown (the repo's file list was truncated)" }, null],
  ['npm not read, scope development', { ...npmDevOnly, lockfileRead: false, lockfileDevOnly: null }, null],
  ['npm not read, even if dev-only were somehow true', { ...npmDevOnly, lockfileRead: false }, null],
  ['npm read, dev-only unknown', { ...npmDevOnly, lockfileDevOnly: null }, null],
  ['scope runtime with dev-only true', { ...npmDevOnly, scope: 'runtime' }, null],
  ['dev-only false with scope development', { ...npmDevOnly, lockfileDevOnly: false }, null],
  ['rubygems not read, scope development', gemsNotRead, 'not_shipped'],
  ['rubygems not read, scope null', { ...gemsNotRead, scope: null }, null],
  ['rubygems not read, scope runtime', { ...gemsNotRead, scope: 'runtime' }, null],
  ['rubygems not read, even if dev-only were somehow false', { ...gemsNotRead, lockfileDevOnly: false }, null],
  ['rubygems read, dev-only null, scope development', { ...gemsNotRead, lockfileRead: true }, null],
  ['rubygems read, dev-only true, scope null', { ...gemsNotRead, lockfileRead: true, lockfileDevOnly: true, scope: null }, 'not_shipped'],
  ['rubygems read, dev-only true, scope runtime', { ...gemsNotRead, lockfileRead: true, lockfileDevOnly: true, scope: 'runtime' }, null],
  ['rubygems read, dev-only false, scope development', { ...gemsNotRead, lockfileRead: true, lockfileDevOnly: false }, null],
  ['pip, not read, scope development', { ...gemsNotRead, ecosystem: 'pip' }, null],
  ['rust, not read, scope development', { ...gemsNotRead, ecosystem: 'rust' }, null],
  ['another ecosystem, read and dev-only', { ...npmDevOnly, ecosystem: 'maven' }, null],
  ['an ecosystem named in another case', { ...npmDevOnly, ecosystem: 'NPM' }, null],
];

describe('tierOne', () => {
  it.each(rows)('%s', (_name, input, expected) => {
    expect(tierOne(input)).toBe(expected);
  });
});
