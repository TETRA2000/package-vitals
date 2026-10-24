import { describe, it, expect } from 'vitest';
import { IpcInputError, parseFindingsRequest, parseReportId, parseReportRequest } from '../../../src/app/main/validate.js';

/** The IpcInputError that `fn` throws. Any other outcome fails the test. */
function inputError(fn: () => unknown): IpcInputError {
  try {
    fn();
  } catch (err) {
    if (err instanceof IpcInputError) return err;
    throw err;
  }
  throw new Error('expected an IpcInputError');
}

const good = { snapshotId: 3, filter: { severities: ['critical', 'high'], repoId: null, ecosystem: 'npm' } };
const withFilter = (patch: Record<string, unknown>) => ({ ...good, filter: { ...good.filter, ...patch } });

describe('IPC input validation', () => {
  it('accepts a well-formed findings request', () => {
    expect(parseFindingsRequest(good)).toEqual(good);
    const other = withFilter({ severities: ['low'], repoId: 7, ecosystem: null });
    expect(parseFindingsRequest(other)).toEqual(other);
  });

  it('rejects malformed findings requests', () => {
    const cases: [label: string, input: unknown, field: string][] = [
      ['null', null, 'request'],
      ['an array', [], 'request'],
      ['a string snapshotId', { ...good, snapshotId: '1' }, 'request.snapshotId'],
      ['a fractional snapshotId', { ...good, snapshotId: 1.5 }, 'request.snapshotId'],
      ['an unsafe snapshotId', { ...good, snapshotId: 2 ** 53 }, 'request.snapshotId'],
      ['a missing filter', { snapshotId: 3 }, 'request'],
      ['an extra key', { ...good, sql: 'DROP TABLE alerts' }, 'request'],
      ['no severities', withFilter({ severities: [] }), 'request.filter.severities'],
      ['a repeated severity', withFilter({ severities: ['critical', 'critical'] }), 'request.filter.severities'],
      ['an unknown severity', withFilter({ severities: ['urgent'] }), 'request.filter.severities'],
      ['a severity list with a hole', withFilter({ severities: [, 'critical'] }), 'request.filter.severities'],
      ['a negative repoId', withFilter({ repoId: -1 }), 'request.filter.repoId'],
      ['a path as the ecosystem', withFilter({ ecosystem: '../x' }), 'request.filter.ecosystem'],
      ['a 33-character ecosystem', withFilter({ ecosystem: 'a'.repeat(33) }), 'request.filter.ecosystem'],
    ];
    for (const [label, input, field] of cases) {
      expect(inputError(() => parseFindingsRequest(input)).message, label).toMatch(new RegExp(`^${field} `));
    }
  });

  it('parseReportRequest rejects unknown kinds and stray keys', () => {
    expect(parseReportRequest({ kind: 'account', snapshotId: 3 })).toEqual({ kind: 'account', snapshotId: 3 });
    expect(parseReportRequest({ kind: 'repo', snapshotId: 3, repoId: 5 })).toEqual({ kind: 'repo', snapshotId: 3, repoId: 5 });
    const cases: [label: string, input: unknown, field: string][] = [
      ['an unknown kind', { kind: 'file' }, 'request.kind'],
      ['a repo request without repoId', { kind: 'repo', snapshotId: 3 }, 'request'],
      ['an account request with repoId', { kind: 'account', snapshotId: 3, repoId: 5 }, 'request'],
    ];
    for (const [label, input, field] of cases) {
      expect(inputError(() => parseReportRequest(input)).message, label).toMatch(new RegExp(`^${field} `));
    }
  });

  it('parseReportId rejects anything but a positive integer', () => {
    expect(parseReportId(4)).toBe(4);
    for (const input of ['../../etc/passwd', 0, '1']) {
      expect(inputError(() => parseReportId(input)).message, String(input)).toMatch(/^reportId /);
    }
  });
});
