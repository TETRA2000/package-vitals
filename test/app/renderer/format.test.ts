import { describe, expect, it } from 'vitest';
import { formatAge, formatUtc, ipcErrorMessage } from '../../../src/app/renderer/format.js';

describe('formatAge', () => {
  it.each([
    ['2026-10-01', '2026-10-24', 'under a month'],
    ['2026-08-20', '2026-10-24', '2 months'],
    ['2025-10-24', '2026-10-24', '1 year'],
    ['2023-05-06', '2026-10-24', '3 years'],
  ])('%s to %s is %s', (from, to, expected) => {
    expect(formatAge(from, to)).toBe(expected);
  });
});

describe('formatUtc', () => {
  it('appends UTC', () => {
    expect(formatUtc('2026-10-24T05:07:09.000Z')).toBe('2026-10-24 05:07 UTC');
  });
});

describe('ipcErrorMessage', () => {
  it('strips the Electron prefix and the error class', () => {
    const err = new Error("Error invoking remote method 'vitals:readReport': IpcInputError: Report is too large to show.");
    expect(ipcErrorMessage(err)).toBe('Report is too large to show.');
  });
  it('handles plain errors and non-errors', () => {
    expect(ipcErrorMessage(new Error('boom'))).toBe('boom');
    expect(ipcErrorMessage('x')).toBe('x');
  });
});
