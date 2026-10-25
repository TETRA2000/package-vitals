import { vi } from 'vitest';
import type { Overview, VitalsApi } from '../../../src/app/shared/api.js';

export const OVERVIEW: Overview = {
  snapshot: { id: 7, ownerLogin: 'TETRA2000', finishedAt: '2026-10-24T05:07:09.000Z', includeForks: false, includeArchived: false },
  monitoring: null,
  repos: [],
  ecosystems: [],
  checkupRunning: false,
};

export function fakeApi(overrides: Partial<VitalsApi> = {}): VitalsApi {
  const api: VitalsApi = {
    getOverview: vi.fn(async () => OVERVIEW),
    listFindings: vi.fn(async () => ({ rows: [], counts: { critical: 0, notTriaged: 0, devOnly: null, reachable: null, uncertain: null } })),
    getFinding: vi.fn(async () => null),
    listRepoCards: vi.fn(async () => []),
    getTreatmentPlan: vi.fn(async () => []),
    copyFindingMarkdown: vi.fn(async () => undefined),
    openFindingOnGitHub: vi.fn(async () => undefined),
    listReports: vi.fn(async () => []),
    readReport: vi.fn(async () => ''),
    generateReport: vi.fn(async () => {
      throw new Error('generateReport is not stubbed');
    }),
    startCheckup: vi.fn(async () => {
      throw new Error('startCheckup is not stubbed');
    }),
    onCheckupProgress: vi.fn(() => () => {}),
  };
  return { ...api, ...overrides };
}
