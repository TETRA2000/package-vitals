import { describe, expect, it } from 'vitest';
import { dependabotAlertUrl } from '../../../src/core/github/urls.js';

describe('dependabotAlertUrl', () => {
  it('builds the alert URL', () => {
    expect(dependabotAlertUrl('TETRA2000/slack-deck', 42)).toBe('https://github.com/TETRA2000/slack-deck/security/dependabot/42');
  });

  it("rejects names that aren't GitHub repo names", () => {
    for (const name of ['TETRA2000/a b', '../x', 'TETRA2000/a/b', 'https://evil.example']) {
      expect(() => dependabotAlertUrl(name, 1), name).toThrow();
    }
    expect(() => dependabotAlertUrl('TETRA2000/a', 0)).toThrow();
    expect(() => dependabotAlertUrl('TETRA2000/a', 1.5)).toThrow();
  });
});
