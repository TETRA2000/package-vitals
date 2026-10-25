import type {
  CheckupSummary,
  FindingDetail,
  FindingFilter,
  FindingKey,
  FindingRow,
  MonitoringSummary,
  RepoCard,
  ReportEntry,
  TreatmentRow,
} from '../../core/types.js';

// The contract between the renderer and main. The renderer imports this file too, so it may import only
// the import-free core types, and its runtime values use no Node APIs.

export interface SnapshotInfo { id: number; ownerLogin: string; finishedAt: string; includeForks: boolean; includeArchived: boolean }
export interface Overview {
  snapshot: SnapshotInfo | null;
  monitoring: MonitoringSummary | null;
  repos: { id: number; fullName: string }[];
  ecosystems: string[];
  checkupRunning: boolean;
}
/** null means "not computed yet", shown as —. */
export interface QueueCounts { critical: number; notTriaged: number; devOnly: number | null; reachable: number | null; uncertain: number | null }
export interface QueueData { rows: FindingRow[]; counts: QueueCounts }
export type ReportRequest = { kind: 'account'; snapshotId: number } | { kind: 'repo'; snapshotId: number; repoId: number };
export interface CheckupProgress { done: number; total: number; repo: string }
export type CheckupResult = { ok: true; summary: CheckupSummary } | { ok: false; message: string };

/** `window.vitals`: every call names data, never a path, URL, or query. */
export interface VitalsApi {
  getOverview(): Promise<Overview>;
  listFindings(req: { snapshotId: number; filter: FindingFilter }): Promise<QueueData>;
  getFinding(key: FindingKey): Promise<FindingDetail | null>;
  listRepoCards(snapshotId: number): Promise<RepoCard[]>;
  getTreatmentPlan(snapshotId: number): Promise<TreatmentRow[]>;
  copyFindingMarkdown(key: FindingKey): Promise<void>;
  openFindingOnGitHub(key: FindingKey): Promise<void>;
  listReports(): Promise<ReportEntry[]>;
  readReport(id: number): Promise<string>;
  generateReport(req: ReportRequest): Promise<ReportEntry>;
  startCheckup(): Promise<CheckupResult>;
  onCheckupProgress(listener: (p: CheckupProgress) => void): () => void;
}

/** The methods that are a request to main and its reply. */
export type InvokeMethod = Exclude<keyof VitalsApi, 'onCheckupProgress'>;

const METHODS = [
  'getOverview',
  'listFindings',
  'getFinding',
  'listRepoCards',
  'getTreatmentPlan',
  'copyFindingMarkdown',
  'openFindingOnGitHub',
  'listReports',
  'readReport',
  'generateReport',
  'startCheckup',
] as const satisfies readonly InvokeMethod[];

/** Fails to compile if an invoke method is missing from the list. */
type AssertNever<T extends never> = T;
type _EveryMethodListed = AssertNever<Exclude<InvokeMethod, (typeof METHODS)[number]>>;

export const INVOKE_METHODS: readonly InvokeMethod[] = METHODS;

export const CHECKUP_PROGRESS_CHANNEL = 'vitals:checkup-progress' as const;

export function channelFor(m: InvokeMethod): string {
  return `vitals:${m}`;
}

/** Main's side of each invoke method. It receives the renderer's argument unchecked and must validate it. */
export type Handlers = { [M in InvokeMethod]: (arg: unknown) => Promise<Awaited<ReturnType<VitalsApi[M]>>> };
