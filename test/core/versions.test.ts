import { describe, it, expect } from 'vitest';
import { compareVersions, isStableVersion, inVulnerableRange } from '../../src/core/versions.js';

const sortWith = (eco: 'npm' | 'rubygems', list: string[]) =>
  [...list].sort((a, b) => compareVersions(eco, a, b) as number);

describe('compareVersions', () => {
  it('compares npm versions by SemVer precedence', () => {
    expect(
      sortWith('npm', ['2.0.0', '1.0.0', '1.10.0', '1.0.0-beta', '1.0.1', '1.0.0-alpha.1', '1.0.0-alpha']),
    ).toEqual(['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0', '1.0.1', '1.10.0', '2.0.0']);
    expect(compareVersions('npm', 'v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('npm', '1.2.3+build.5', '1.2.3')).toBe(0);
    expect(compareVersions('npm', 'latest', '1.0.0')).toBeNull();
    expect(compareVersions('npm', '1.0.0', '1.2')).toBeNull();
  });

  it('compares gem versions like Gem::Version', () => {
    expect(
      sortWith('rubygems', ['2.0.0', '1.10', '1.0.1', '2.0.0.rc1', '1.0.b1', '1.9', '1.0', '1.0.a']),
    ).toEqual(['1.0.a', '1.0.b1', '1.0', '1.0.1', '1.9', '1.10', '2.0.0.rc1', '2.0.0']);
    expect(compareVersions('rubygems', '1.0', '1')).toBe(0);
    expect(compareVersions('rubygems', '1.0-beta', '1.0.pre.beta')).toBe(0);
    expect(compareVersions('rubygems', 'git+https://x', '1.0')).toBeNull();
  });
});

describe('isStableVersion', () => {
  it('knows stable versions', () => {
    expect(isStableVersion('npm', '1.0.0')).toBe(true);
    expect(isStableVersion('npm', '1.0.0-rc.1')).toBe(false);
    expect(isStableVersion('rubygems', '7.1.0')).toBe(true);
    expect(isStableVersion('rubygems', '7.1.0.beta1')).toBe(false);
  });
});

describe('inVulnerableRange', () => {
  it('evaluates GHSA ranges', () => {
    expect(inVulnerableRange('npm', '0.0.8', '< 0.2.4')).toBe(true);
    expect(inVulnerableRange('npm', '1.2.5', '>= 1.0.0, < 1.2.6')).toBe(true);
    expect(inVulnerableRange('npm', '1.2.5', '>=1.0.0,<1.2.6')).toBe(true);
    expect(inVulnerableRange('npm', '2.0.0', '= 2.0.0')).toBe(true);
    expect(inVulnerableRange('rubygems', '6.1.7.3', '< 6.1.7.4')).toBe(true);
    expect(inVulnerableRange('npm', '1.2.6', '>= 1.0.0, < 1.2.6')).toBe(false);
    expect(inVulnerableRange('npm', '1.0.0', '> 1.0.0')).toBe(false);
    expect(inVulnerableRange('npm', '1.0.0', '<= 1.0.0')).toBe(true);
  });

  it('is null when it cannot decide', () => {
    expect(inVulnerableRange('npm', '1.0.0', null)).toBeNull();
    expect(inVulnerableRange('npm', '1.0.0', '~> 1.0')).toBeNull();
    expect(inVulnerableRange('npm', '1.0.0', '')).toBeNull();
    expect(inVulnerableRange('npm', 'git+https://x', '< 2.0.0')).toBeNull();
    expect(inVulnerableRange('npm', '1.0.0', '< latest')).toBeNull();
  });
});
