import { describe, it, expect } from 'vitest';
import { PublicApiClient } from '../../../src/core/http/public-client.js';
import { NPM_REGISTRY_ORIGIN, RUBYGEMS_ORIGIN, npmRegistry, parseCompactIndex, rubygemsRegistry } from '../../../src/core/registry/registry.js';
import { fakeHttp } from '../../helpers/fake-http.js';

const client = (origin: string, f: ReturnType<typeof fakeHttp>) => new PublicApiClient({ origin, fetch: f, sleep: async () => {} });

const MKDIRP = {
  name: 'mkdirp',
  'dist-tags': { latest: '1.0.0' },
  versions: {
    '1.0.0': {},
    '0.5.6': { dependencies: { minimist: '^1.2.6' } },
    '0.5.1': { dependencies: { minimist: '0.0.8' }, deprecated: 'Legacy versions of mkdirp are no longer supported.' },
    'not a version': {},
  },
};

describe('npm registry', () => {
  it('npm latest and versions', async () => {
    const f = fakeHttp({
      'GET https://registry.npmjs.org/-/package/@types%2Fnode/dist-tags': { body: { latest: '24.0.0', next: '25.0.0-rc.1' } },
      'GET https://registry.npmjs.org/-/package/nope/dist-tags': { status: 404, body: 'Not Found' },
      'GET https://registry.npmjs.org/-/package/untagged/dist-tags': { body: { beta: '1.0.0-beta.1' } },
      'GET https://registry.npmjs.org/mkdirp': { body: MKDIRP },
    });
    const npm = npmRegistry(client(NPM_REGISTRY_ORIGIN, f));
    expect(await npm.latest('@types/node')).toEqual({ status: 'ok', latest: '24.0.0' });
    expect(await npm.latest('nope')).toEqual({ status: 'not_found' });
    expect(await npm.latest('untagged')).toEqual({ status: 'not_found' });
    expect(await npm.versions('mkdirp')).toEqual([
      { version: '0.5.1', dependencies: ['minimist'], deprecated: true },
      { version: '0.5.6', dependencies: ['minimist'], deprecated: false },
      { version: '1.0.0', dependencies: [], deprecated: false },
    ]);
    expect(await npm.versions('nope')).toBeNull();
    const doc = f.calls.find((c) => c.url.endsWith('/mkdirp'))!;
    expect(doc.headers['Accept']).toBe('application/vnd.npm.install-v1+json');
  });

  it('merges the three dependency kinds and counts an empty deprecation message', async () => {
    const f = fakeHttp({
      'GET https://registry.npmjs.org/p': {
        body: {
          versions: {
            '1.0.0': {
              dependencies: { a: '1' },
              optionalDependencies: { b: '1', a: '1' },
              peerDependencies: { c: '1' },
              deprecated: '',
            },
            '1.0.1': { deprecated: true },
          },
        },
      },
    });
    expect(await npmRegistry(client(NPM_REGISTRY_ORIGIN, f)).versions('p')).toEqual([
      { version: '1.0.0', dependencies: ['a', 'b', 'c'], deprecated: true },
      { version: '1.0.1', dependencies: [], deprecated: false },
    ]);
  });
});

describe('RubyGems registry', () => {
  it('RubyGems treats "unknown" as not found', async () => {
    const f = fakeHttp({
      'GET https://rubygems.org/api/v1/versions/nokogiri/latest.json': { body: { version: '1.19.4' } },
      'GET https://rubygems.org/api/v1/versions/ghost/latest.json': { body: { version: 'unknown' } },
      'GET https://rubygems.org/api/v1/versions/gone/latest.json': { status: 404, body: {} },
    });
    const gems = rubygemsRegistry(client(RUBYGEMS_ORIGIN, f));
    expect(await gems.latest('nokogiri')).toEqual({ status: 'ok', latest: '1.19.4' });
    expect(await gems.latest('ghost')).toEqual({ status: 'not_found' });
    expect(await gems.latest('gone')).toEqual({ status: 'not_found' });
  });

  it('reads the compact index', async () => {
    const text = [
      '---',
      '0.1.0 |checksum:aa,created_at:2020-01-01',
      '',
      '2.2.0 rack:>= 1.3,json:>= 1&< 3|checksum:bb,ruby:>= 2.0,created_at:2020-02-02',
      '2.2.0-java rack:>= 1.3,jruby-x:>= 1|checksum:cc',
      'garbage-line-with-no-pipe',
      '|checksum:dd',
    ].join('\n');
    expect(parseCompactIndex(text)).toEqual([
      { version: '0.1.0', dependencies: [], deprecated: false },
      { version: '2.2.0', dependencies: ['rack', 'json', 'jruby-x'], deprecated: false },
    ]);
    const f = fakeHttp({ 'GET https://rubygems.org/info/rack-test': { text } });
    expect(await rubygemsRegistry(client(RUBYGEMS_ORIGIN, f)).versions('rack-test')).toHaveLength(2);
    expect(await rubygemsRegistry(client(RUBYGEMS_ORIGIN, f)).versions('missing')).toBeNull();
  });
});

describe('failures', () => {
  it('a failed lookup is a value, not a throw', async () => {
    const f = fakeHttp({
      'GET https://registry.npmjs.org/-/package/a/dist-tags': { status: 500, statusText: 'Internal Server Error', body: 'boom' },
      'GET https://registry.npmjs.org/-/package/b/dist-tags': { body: ['not', 'an', 'object'] },
      'GET https://registry.npmjs.org/a': { status: 500, body: 'boom' },
      'GET https://registry.npmjs.org/b': { body: { versions: 'nope' } },
      'GET https://registry.npmjs.org/c': { networkError: true },
    });
    const npm = npmRegistry(new PublicApiClient({ origin: NPM_REGISTRY_ORIGIN, fetch: f, sleep: async () => {}, maxRetries: 0 }));
    expect(await npm.latest('a')).toEqual({ status: 'error', message: 'Internal Server Error (HTTP 500)' });
    expect(await npm.latest('b')).toEqual({ status: 'error', message: "Couldn't read the registry's answer." });
    expect(await npm.versions('a')).toBeNull();
    expect(await npm.versions('b')).toBeNull();
    expect(await npm.versions('c')).toBeNull();
  });
});
