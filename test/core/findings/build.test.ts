import { describe, it, expect } from 'vitest';
import { buildRepoFindings, type BuiltFinding } from '../../../src/core/findings/build.js';
import type { DepEdge, DepGraph, DepNode } from '../../../src/core/lockfiles/graph.js';
import type { ProjectScan } from '../../../src/core/lockfiles/scan.js';
import { osvPackageKey, type OsvAdvisory, type OsvRange } from '../../../src/core/osv/osv.js';
import type { DependabotAlert } from '../../../src/core/types.js';

const prod = (to: number): DepEdge => ({ to, kind: 'prod' });
const dev = (to: number): DepEdge => ({ to, kind: 'dev' });
const node = (id: number, name: string, version: string, registry = true): DepNode => ({ id, name, version, registry, lockDev: null });

/** A complete graph with one root. */
const graph = (rootEdges: DepEdge[], nodes: DepNode[], edges: DepEdge[][] = nodes.map(() => []), label = 'slack-deck'): DepGraph => ({
  format: 'npm-v3',
  roots: [{ label, path: '.', edges: rootEdges }],
  nodes,
  edges,
  unresolved: [],
  devKnown: true,
});

const project = (path: string, g: DepGraph, o: Partial<ProjectScan> = {}): ProjectScan => ({
  path,
  ecosystem: 'npm',
  blobSha: 'sha',
  result: { status: 'ok', graph: g },
  jsBundler: null,
  ...o,
});

// slack-deck → mkdirp 0.5.1 → minimist 0.0.8, and slack-deck → minimist 1.2.8
const slackDeck = () =>
  graph([prod(0), prod(2)], [node(0, 'mkdirp', '0.5.1'), node(1, 'minimist', '0.0.8'), node(2, 'minimist', '1.2.8')], [[prod(1)], [], []]);

const alert = (o: Partial<DependabotAlert> = {}): DependabotAlert => ({
  number: 41,
  state: 'open',
  ecosystem: 'npm',
  packageName: 'minimist',
  manifestPath: 'package-lock.json',
  scope: 'runtime',
  relationship: 'transitive',
  ghsaId: 'GHSA-xvch-5gv4-984h',
  cveId: 'CVE-2021-44906',
  severity: 'critical',
  summary: 'Prototype Pollution in minimist',
  vulnerableRange: '< 0.2.4',
  firstPatched: '0.2.4',
  createdAt: '2022-03-18T00:00:00Z',
  dismissedAt: null,
  dismissedReason: null,
  dismissedComment: null,
  fixedAt: null,
  ...o,
});

const semver = (...events: OsvRange['events']): OsvRange => ({ type: 'SEMVER', events });
const advisory = (id: string, o: Partial<OsvAdvisory> = {}): OsvAdvisory => ({
  id, aliases: [], summary: `${id} summary`, severity: 'high', severitySource: 'advisory', ranges: [], ...o,
});

const MINIMIST = advisory('GHSA-xvch-5gv4-984h', {
  aliases: ['CVE-2021-44906'],
  summary: 'Prototype Pollution in minimist',
  severity: 'critical',
  ranges: [semver({ introduced: '0' }, { fixed: '0.2.4' }), semver({ introduced: '1.0.0' }, { fixed: '1.2.6' })],
});

/** An OSV map with an entry for every registry node of the ok projects: `found["name@version"]`, else `[]`. */
function osvFor(projects: ProjectScan[], found: Record<string, OsvAdvisory[]> = {}): Map<string, OsvAdvisory[]> {
  const map = new Map<string, OsvAdvisory[]>();
  for (const p of projects) {
    if (p.result.status !== 'ok') continue;
    for (const n of p.result.graph.nodes) {
      if (n.registry) map.set(osvPackageKey({ ecosystem: p.ecosystem, name: n.name, version: n.version }), found[`${n.name}@${n.version}`] ?? []);
    }
  }
  return map;
}

const build = (alerts: DependabotAlert[], projects: ProjectScan[], osv: Map<string, OsvAdvisory[]> | null = null) =>
  buildRepoFindings({ alerts, projects, osv });
const summary = (built: BuiltFinding[]) =>
  built.map((f) => [f.record.alertNumber, f.record.source, f.record.packageName, f.record.advisoryId]);

describe('buildRepoFindings: Dependabot findings', () => {
  it('an alert takes installed versions, chains, and relationship from its lockfile', () => {
    const built = build([alert()], [project('package-lock.json', slackDeck())]);
    expect(built).toEqual([
      {
        projectPath: 'package-lock.json',
        targets: [1],
        record: {
          alertNumber: 41,
          source: 'dependabot',
          ecosystem: 'npm',
          packageName: 'minimist',
          manifestPath: 'package-lock.json',
          advisoryId: 'GHSA-xvch-5gv4-984h',
          cveId: 'CVE-2021-44906',
          severity: 'critical',
          severitySource: 'advisory',
          summary: 'Prototype Pollution in minimist',
          vulnerableRange: '< 0.2.4',
          firstPatched: '0.2.4',
          createdAt: '2022-03-18T00:00:00Z',
          scope: 'runtime',
          githubRelationship: 'transitive',
          installedVersions: ['0.0.8'],
          relationship: 'transitive',
          chains: [
            { root: 'slack-deck', links: [{ name: 'mkdirp', version: '0.5.1' }, { name: 'minimist', version: '0.0.8' }], dev: false },
          ],
          chainCount: 1,
          lockfileRead: true,
          lockfileDevOnly: false,
          jsBundler: null,
          tier: null,
          upgrades: null,
        },
      },
    ]);
  });

  it('only open alerts become findings, in alert-number order', () => {
    const alerts = [
      alert({ number: 42 }),
      alert({ number: 7 }),
      alert({ number: 3, state: 'dismissed' }),
      alert({ number: 4, state: 'auto_dismissed' }),
      alert({ number: 5, state: 'fixed' }),
    ];
    expect(build(alerts, []).map((f) => f.record.alertNumber)).toEqual([7, 42]);
  });

  it("the alert's range picks the targets, and a version it can't compare counts", () => {
    // slack-deck → (dev) mkdirp → minimist 0.0.8, and slack-deck → minimist 1.2.8
    const g = graph([dev(0), prod(2)], [node(0, 'mkdirp', '0.5.1'), node(1, 'minimist', '0.0.8'), node(2, 'minimist', '1.2.8')], [[prod(1)], [], []]);
    const dev008 = build([alert({ scope: 'development' })], [project('package-lock.json', g)]);
    expect(dev008[0]!.targets).toEqual([1]);
    expect(dev008[0]!.record).toMatchObject({ installedVersions: ['0.0.8'], lockfileDevOnly: true, tier: 'not_shipped' });

    // A runtime minimist at a version that can't be compared with the range might be vulnerable.
    const unknown = graph(g.roots[0]!.edges, [...g.nodes.slice(0, 2), node(2, 'minimist', '1.2')], g.edges);
    const withUnknown = build([alert({ scope: 'development' })], [project('package-lock.json', unknown)]);
    expect(withUnknown[0]!.targets).toEqual([1, 2]);
    expect(withUnknown[0]!.record).toMatchObject({ installedVersions: ['0.0.8', '1.2'], lockfileDevOnly: false, tier: null });

    // Without a range, every installed minimist is a target.
    const noRange = build([alert({ scope: 'development', vulnerableRange: null })], [project('package-lock.json', g)]);
    expect(noRange[0]!.record).toMatchObject({ installedVersions: ['0.0.8', '1.2.8'], relationship: 'mixed', lockfileDevOnly: false, tier: null });
  });

  it('installed versions are unique and in version order, with ones that can\'t be compared last', () => {
    const versions = ['0.0.10', 'zzz', '0.0.8', '0.0.10', 'aaa', '0.0.9'];
    const g = graph(versions.map((_, i) => prod(i)), versions.map((v, i) => node(i, 'minimist', v)));
    const [f] = build([alert({ vulnerableRange: null })], [project('package-lock.json', g)]);
    expect(f!.record.installedVersions).toEqual(['0.0.8', '0.0.9', '0.0.10', 'aaa', 'zzz']);
    expect(f!.targets).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('a package.json manifest uses the lockfile beside it', () => {
    const projects = [project('package-lock.json', graph([], [])), project('web/yarn.lock', slackDeck())];
    const [beside] = build([alert({ manifestPath: 'web/package.json' })], projects);
    expect(beside!.projectPath).toBe('web/yarn.lock');
    expect(beside!.record).toMatchObject({ manifestPath: 'web/package.json', lockfileRead: true, installedVersions: ['0.0.8'] });

    const [top] = build([alert({ manifestPath: 'package.json' })], projects);
    expect(top!.projectPath).toBe('package-lock.json');

    const levelZero = (manifestPath: string, list: ProjectScan[], o: Partial<DependabotAlert> = {}) => {
      const [f] = build([alert({ manifestPath, ...o })], list);
      return [f!.projectPath, f!.record.lockfileRead];
    };
    // Two lockfiles beside it: which one Dependabot read can't be told.
    expect(levelZero('web/package.json', [...projects, project('web/package-lock.json', slackDeck())])).toEqual([null, false]);
    // A lockfile that couldn't be read isn't used.
    const failed: ProjectScan = { ...projects[1]!, result: { status: 'error', message: "Couldn't read this lockfile." } };
    expect(levelZero('web/yarn.lock', [failed])).toEqual([null, false]);
    expect(levelZero('web/package.json', [failed])).toEqual([null, false]);
    // Only a package.json or Gemfile manifest looks beside itself.
    expect(levelZero('web/npm-shrinkwrap.json', projects)).toEqual([null, false]);
    // A RubyGems alert never takes an npm lockfile, nor an npm alert a Gemfile.lock.
    expect(levelZero('web/Gemfile', projects, { ecosystem: 'rubygems' })).toEqual([null, false]);
    expect(levelZero('web/yarn.lock', projects, { ecosystem: 'rubygems' })).toEqual([null, false]);
    const gems = [project('Gemfile.lock', slackDeck(), { ecosystem: 'rubygems' })];
    expect(levelZero('Gemfile', gems)).toEqual([null, false]);
    expect(levelZero('Gemfile.lock', gems)).toEqual([null, false]);
  });

  it('an alert with no lockfile keeps Level 0 data', () => {
    expect(build([alert({ scope: 'development' })], [])).toEqual([
      {
        projectPath: null,
        targets: [],
        record: expect.objectContaining({
          source: 'dependabot',
          scope: 'development',
          installedVersions: [],
          relationship: null,
          chains: [],
          chainCount: 0,
          lockfileRead: false,
          lockfileDevOnly: null,
          jsBundler: null,
          // npm needs its lockfile read.
          tier: null,
        }),
      },
    ]);
    // Without a lockfile, Dependabot's development scope is enough for RubyGems.
    const [gem] = build([alert({ ecosystem: 'rubygems', packageName: 'rexml', manifestPath: 'Gemfile.lock', scope: 'development' })], []);
    expect(gem!.record).toMatchObject({ lockfileRead: false, tier: 'not_shipped' });
    // Other ecosystems stay not triaged.
    const [pip] = build([alert({ ecosystem: 'pip', packageName: 'jinja2', manifestPath: 'requirements.txt', scope: 'development' })], []);
    expect(pip!.record).toMatchObject({ ecosystem: 'pip', lockfileRead: false, tier: null });
  });

  it('a dev-only finding in a bundler project stays not triaged', () => {
    // slack-deck → (dev) mkdirp → minimist 0.0.8; OSV knows of an mkdirp advisory too.
    const g = graph([dev(0)], [node(0, 'mkdirp', '0.5.1'), node(1, 'minimist', '0.0.8')], [[prod(1)], []]);
    const mkdirp = advisory('GHSA-mkdp-0000-0000', { ranges: [semver({ introduced: '0' }, { fixed: '0.5.2' })] });
    const run = (jsBundler: string | null) => {
      const projects = [project('package-lock.json', g, { jsBundler })];
      return build([alert({ scope: 'development' })], projects, osvFor(projects, { 'mkdirp@0.5.1': [mkdirp] })).map((f) => [
        f.record.source,
        f.record.packageName,
        f.record.lockfileDevOnly,
        f.record.jsBundler,
        f.record.tier,
      ]);
    };
    expect(run(null)).toEqual([
      ['dependabot', 'minimist', true, null, 'not_shipped'],
      ['osv', 'mkdirp', true, null, 'not_shipped'],
    ]);
    expect(run('vite (dependency)')).toEqual([
      ['dependabot', 'minimist', true, 'vite (dependency)', null],
      ['osv', 'mkdirp', true, 'vite (dependency)', null],
    ]);
  });

  it('Dependabot\'s runtime scope keeps a dev-only lockfile finding', () => {
    const g = graph([dev(0)], [node(0, 'mkdirp', '0.5.1'), node(1, 'minimist', '0.0.8')], [[prod(1)], []]);
    const [f] = build([alert({ scope: 'runtime' })], [project('package-lock.json', g)]);
    expect(f!.record).toMatchObject({ lockfileDevOnly: true, tier: null });
  });
});

describe('buildRepoFindings: matching OSV', () => {
  const projects = [project('package-lock.json', slackDeck())];
  const osv = osvFor(projects, { 'minimist@0.0.8': [MINIMIST] });

  it('an OSV match makes it "both", through the GHSA ID or a CVE alias', () => {
    expect(summary(build([alert()], projects, osv))).toEqual([[41, 'both', 'minimist', 'GHSA-xvch-5gv4-984h']]);
    // The alert's GHSA ID isn't OSV's, but the CVE is one of its aliases.
    const viaCve = alert({ ghsaId: 'GHSA-0000-0000-0000' });
    expect(summary(build([viaCve], projects, osv))).toEqual([[41, 'both', 'minimist', 'GHSA-0000-0000-0000']]);
    // OSV's record is the CVE itself, or aliases the GHSA ID.
    const asCve = osvFor(projects, { 'minimist@0.0.8': [advisory('CVE-2021-44906')] });
    expect(summary(build([viaCve], projects, asCve))).toEqual([[41, 'both', 'minimist', 'GHSA-0000-0000-0000']]);
    const aliasingGhsa = osvFor(projects, { 'minimist@0.0.8': [advisory('MAL-2021-1', { aliases: ['GHSA-xvch-5gv4-984h'] })] });
    expect(summary(build([alert({ cveId: null })], projects, aliasingGhsa))).toEqual([[41, 'both', 'minimist', 'GHSA-xvch-5gv4-984h']]);

    // Neither matches: the alert stays Dependabot's and OSV's record is a finding of its own.
    const unmatched = alert({ ghsaId: 'GHSA-0000-0000-0000', cveId: null });
    expect(summary(build([unmatched], projects, osv))).toEqual([
      [41, 'dependabot', 'minimist', 'GHSA-0000-0000-0000'],
      [null, 'osv', 'minimist', 'GHSA-xvch-5gv4-984h'],
    ]);
  });

  it('only a target\'s OSV records make it "both"', () => {
    // OSV reports minimist 1.2.8, which the alert's range leaves out.
    const other = osvFor(projects, { 'minimist@1.2.8': [MINIMIST] });
    const [f] = build([alert()], projects, other);
    expect(f!.record.source).toBe('dependabot');
    // A non-registry node is never looked up, whatever the map holds.
    const git = graph([prod(0)], [node(0, 'minimist', '0.0.8', false)]);
    const gitProjects = [project('package-lock.json', git)];
    const map = new Map([[osvPackageKey({ ecosystem: 'npm', name: 'minimist', version: '0.0.8' }), [MINIMIST]]]);
    expect(summary(build([alert()], gitProjects, map))).toEqual([[41, 'dependabot', 'minimist', 'GHSA-xvch-5gv4-984h']]);
    expect(build([], gitProjects, map)).toEqual([]);
  });

  it('a match with a dismissed alert adds nothing; with a fixed alert it is OSV only', () => {
    expect(build([alert({ state: 'dismissed' })], projects, osv)).toEqual([]);
    expect(build([alert({ state: 'auto_dismissed' })], projects, osv)).toEqual([]);
    // Matched through the CVE alias, too.
    expect(build([alert({ state: 'dismissed', ghsaId: 'GHSA-0000-0000-0000' })], projects, osv)).toEqual([]);

    const fixed = build([alert({ state: 'fixed' })], projects, osv);
    expect(summary(fixed)).toEqual([[null, 'osv', 'minimist', 'GHSA-xvch-5gv4-984h']]);
    expect(fixed[0]!.record).toMatchObject({ installedVersions: ['0.0.8'], firstPatched: '0.2.4' });
  });

  it('an alert in another project or on another package hides nothing', () => {
    const two = [project('package-lock.json', slackDeck()), project('web/yarn.lock', slackDeck())];
    const both = osvFor(two, { 'minimist@0.0.8': [MINIMIST] });
    // The dismissed alert is on web's package.json, so it accounts for web/yarn.lock only.
    const built = build([alert({ state: 'dismissed', manifestPath: 'web/package.json' })], two, both);
    expect(built.map((f) => [f.record.source, f.record.manifestPath])).toEqual([['osv', 'package-lock.json']]);
    // An alert on mkdirp doesn't account for minimist's record, even with the same advisory.
    const onMkdirp = build([alert({ state: 'dismissed', packageName: 'mkdirp' })], projects, osv);
    expect(onMkdirp.map((f) => [f.record.source, f.record.packageName])).toEqual([['osv', 'minimist']]);
  });

  it('without OSV there are no OSV-only findings and nothing is "both"', () => {
    const unmatched = alert({ number: 9, ghsaId: 'GHSA-0000-0000-0000', cveId: null });
    const withMkdirp = osvFor(projects, { 'minimist@0.0.8': [MINIMIST], 'mkdirp@0.5.1': [advisory('GHSA-zzzz-0000-0000')] });
    expect(summary(build([alert(), unmatched], projects, withMkdirp))).toEqual([
      [9, 'dependabot', 'minimist', 'GHSA-0000-0000-0000'],
      [41, 'both', 'minimist', 'GHSA-xvch-5gv4-984h'],
      [null, 'osv', 'mkdirp', 'GHSA-zzzz-0000-0000'],
    ]);
    expect(summary(build([alert(), unmatched], projects, null))).toEqual([
      [9, 'dependabot', 'minimist', 'GHSA-0000-0000-0000'],
      [41, 'dependabot', 'minimist', 'GHSA-xvch-5gv4-984h'],
    ]);
  });

  it('rubygems alerts match RubyGems results', () => {
    // A Rails app: nokogiri at runtime, and rubocop → rexml only in the development group.
    const g: DepGraph = {
      ...graph(
        [prod(0), dev(1)],
        [node(0, 'nokogiri', '1.10.0'), node(1, 'rubocop', '1.0.0'), node(2, 'rexml', '3.2.4')],
        [[], [prod(2)], []],
        'Gemfile',
      ),
      format: 'bundler',
    };
    const gems = [project('Gemfile.lock', g, { ecosystem: 'rubygems' })];
    const ecosystem = (events: OsvRange['events']): OsvRange[] => [{ type: 'ECOSYSTEM', events }];
    const map = osvFor(gems, {
      'nokogiri@1.10.0': [advisory('GHSA-vr8q-g5c7-m54m', { aliases: ['CVE-2020-26247'], severity: 'medium', ranges: ecosystem([{ introduced: '0' }, { fixed: '1.11.0.rc4' }]) })],
      'rexml@3.2.4': [advisory('GHSA-8cr8-4vfw-mr7h', { aliases: ['CVE-2021-28965'], ranges: ecosystem([{ introduced: '0' }, { fixed: '3.2.5' }]) })],
    });
    const nokogiri = alert({
      number: 3, ecosystem: 'rubygems', packageName: 'nokogiri', manifestPath: 'Gemfile.lock',
      ghsaId: 'GHSA-vr8q-g5c7-m54m', cveId: 'CVE-2020-26247', vulnerableRange: '< 1.11.0.rc4', scope: 'runtime',
    });
    const built = build([nokogiri], gems, map);
    expect(built.map((f) => [f.record.alertNumber, f.record.source, f.record.packageName, f.record.installedVersions, f.record.tier])).toEqual([
      [3, 'both', 'nokogiri', ['1.10.0'], null],
      [null, 'osv', 'rexml', ['3.2.4'], 'not_shipped'],
    ]);
    expect(built[1]!.record).toMatchObject({
      ecosystem: 'rubygems', manifestPath: 'Gemfile.lock', cveId: 'CVE-2021-28965', lockfileDevOnly: true,
      vulnerableRange: '< 3.2.5', firstPatched: '3.2.5',
      chains: [{ root: 'Gemfile', links: [{ name: 'rubocop', version: '1.0.0' }, { name: 'rexml', version: '3.2.4' }], dev: true }],
    });
    // An alert on the Gemfile uses the Gemfile.lock beside it.
    const viaGemfile = build([{ ...nokogiri, manifestPath: 'Gemfile' }], gems, map);
    expect(viaGemfile[0]).toMatchObject({ projectPath: 'Gemfile.lock', record: { source: 'both', lockfileRead: true } });
  });
});

describe('buildRepoFindings: OSV-only findings', () => {
  it('OSV-only findings group versions and linked records', () => {
    // slack-deck → event-stream → flatmap-stream; → (dev) lodash 4.17.4; → async → lodash 4.17.15
    const g = graph(
      [prod(0), dev(2), prod(4)],
      [node(0, 'event-stream', '3.3.6'), node(1, 'flatmap-stream', '0.1.1'), node(2, 'lodash', '4.17.4'), node(3, 'lodash', '4.17.15'), node(4, 'async', '2.6.0')],
      [[prod(1)], [], [], [], [prod(3)]],
    );
    const projects = [project('package-lock.json', g)];
    const ghsa = advisory('GHSA-mh6f-8j2x-4483', { summary: 'Critical severity vulnerability that affects event-stream and flatmap-stream', severity: 'critical', ranges: [semver({ introduced: '0' })] });
    // The malware record names the GHSA one, not the other way round.
    const mal = advisory('MAL-2025-20690', { aliases: ['GHSA-mh6f-8j2x-4483'], summary: 'Malicious code in flatmap-stream (npm)', severity: 'critical', severitySource: 'malware', ranges: [semver({ introduced: '0' })] });
    const pollution = advisory('GHSA-p6mc-m468-83gw', { aliases: ['CVE-2020-8203'], summary: 'Prototype Pollution in lodash', ranges: [semver({ introduced: '3.7.0' }, { fixed: '4.17.19' })] });
    const injection = advisory('GHSA-35jh-r3h4-6jhm', { aliases: ['CVE-2021-23337'], summary: 'Command Injection in lodash', ranges: [semver({ introduced: '0' }, { fixed: '4.17.21' })] });
    const osv = osvFor(projects, {
      'flatmap-stream@0.1.1': [mal, ghsa],
      'lodash@4.17.4': [pollution],
      'lodash@4.17.15': [pollution, injection],
    });
    const built = build([], projects, osv);
    expect(built.map((f) => [f.record.packageName, f.record.advisoryId, f.record.installedVersions])).toEqual([
      ['flatmap-stream', 'GHSA-mh6f-8j2x-4483', ['0.1.1']],
      ['lodash', 'GHSA-35jh-r3h4-6jhm', ['4.17.15']],
      ['lodash', 'GHSA-p6mc-m468-83gw', ['4.17.4', '4.17.15']],
    ]);
    // At equal severity the advisory's own beats the malware record's.
    expect(built[0]!.record).toMatchObject({
      severity: 'critical', severitySource: 'advisory', cveId: null,
      summary: 'Critical severity vulnerability that affects event-stream and flatmap-stream',
      vulnerableRange: 'all versions', firstPatched: null,
    });
    expect(built[2]).toEqual({
      projectPath: 'package-lock.json',
      targets: [2, 3],
      record: {
        alertNumber: null,
        source: 'osv',
        ecosystem: 'npm',
        packageName: 'lodash',
        manifestPath: 'package-lock.json',
        advisoryId: 'GHSA-p6mc-m468-83gw',
        cveId: 'CVE-2020-8203',
        severity: 'high',
        severitySource: 'advisory',
        summary: 'Prototype Pollution in lodash',
        vulnerableRange: '>= 3.7.0, < 4.17.19',
        firstPatched: '4.17.19',
        createdAt: null,
        scope: null,
        githubRelationship: null,
        installedVersions: ['4.17.4', '4.17.15'],
        relationship: 'mixed',
        chains: [
          { root: 'slack-deck', links: [{ name: 'lodash', version: '4.17.4' }], dev: true },
          { root: 'slack-deck', links: [{ name: 'async', version: '2.6.0' }, { name: 'lodash', version: '4.17.15' }], dev: false },
        ],
        chainCount: 2,
        lockfileRead: true,
        // 4.17.15 ships, so the finding does too, though 4.17.4 is dev-only.
        lockfileDevOnly: false,
        jsBundler: null,
        tier: null,
        upgrades: null,
      },
    });
  });

  it('a linked group takes its worst severity, its lowest ID without a GHSA one, and a CVE from any record', () => {
    const g = graph([prod(0)], [node(0, 'flatmap-stream', '0.1.1')]);
    const projects = [project('package-lock.json', g)];
    const run = (advisories: OsvAdvisory[]) => build([], projects, osvFor(projects, { 'flatmap-stream@0.1.1': advisories }));

    const worse = run([
      advisory('GHSA-mh6f-8j2x-4483', { severity: 'high' }),
      advisory('MAL-2025-20690', { aliases: ['GHSA-mh6f-8j2x-4483'], severity: 'critical', severitySource: 'malware' }),
    ]);
    expect(worse.map((f) => [f.record.advisoryId, f.record.severity, f.record.severitySource, f.record.summary])).toEqual([
      ['GHSA-mh6f-8j2x-4483', 'critical', 'malware', 'GHSA-mh6f-8j2x-4483 summary'],
    ]);

    // Linked through a shared alias; no GHSA ID, so the lowest ID. The CVE comes from whichever record has one.
    const noGhsa = run([
      advisory('MAL-2025-2', { aliases: ['OSV-2025-1'], severity: 'critical', severitySource: 'assumed' }),
      advisory('MAL-2025-1', { aliases: ['OSV-2025-1'], severity: 'low' }),
      advisory('OSV-2025-9', { aliases: ['MAL-2025-2', 'CVE-2025-0002'], severity: 'critical', severitySource: 'malware' }),
    ]);
    expect(noGhsa.map((f) => [f.record.advisoryId, f.record.cveId, f.record.severity, f.record.severitySource])).toEqual([
      ['MAL-2025-1', 'CVE-2025-0002', 'critical', 'malware'],
    ]);

    // Of several GHSA IDs, the lowest, even when another ID sorts lower; its own CVE comes first.
    const twoGhsa = run([
      advisory('GHSA-bbbb-0000-0000', { aliases: ['CVE-2025-0001'] }),
      advisory('GHSA-aaaa-0000-0000', { aliases: ['GHSA-bbbb-0000-0000', 'CVE-2025-0009'] }),
      advisory('BIT-flatmap-stream-2025-1', { aliases: ['GHSA-aaaa-0000-0000', 'CVE-2025-0001'] }),
    ]);
    expect(twoGhsa.map((f) => [f.record.advisoryId, f.record.cveId])).toEqual([['GHSA-aaaa-0000-0000', 'CVE-2025-0009']]);
  });

  it('OSV-only findings come in package then advisory order, across projects', () => {
    const projects = [project('web/package-lock.json', slackDeck()), project('package-lock.json', slackDeck())];
    const osv = osvFor(projects, {
      'minimist@0.0.8': [MINIMIST, advisory('GHSA-aaaa-0000-0000')],
      'mkdirp@0.5.1': [advisory('GHSA-zzzz-0000-0000')],
    });
    const built = build([alert({ number: 2, ghsaId: 'GHSA-0000-0000-0000', cveId: null })], projects, osv);
    expect(built.map((f) => [f.record.alertNumber, f.record.packageName, f.record.advisoryId, f.record.manifestPath])).toEqual([
      [2, 'minimist', 'GHSA-0000-0000-0000', 'package-lock.json'],
      [null, 'minimist', 'GHSA-aaaa-0000-0000', 'package-lock.json'],
      [null, 'minimist', 'GHSA-aaaa-0000-0000', 'web/package-lock.json'],
      [null, 'minimist', 'GHSA-xvch-5gv4-984h', 'package-lock.json'],
      [null, 'minimist', 'GHSA-xvch-5gv4-984h', 'web/package-lock.json'],
      [null, 'mkdirp', 'GHSA-zzzz-0000-0000', 'package-lock.json'],
      [null, 'mkdirp', 'GHSA-zzzz-0000-0000', 'web/package-lock.json'],
    ]);
  });
});
