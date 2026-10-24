import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { CheckupProgress, InvokeMethod, VitalsApi } from '../shared/api.js' with { 'resolution-mode': 'import' };

// The only bridge from the renderer to main. It exposes named methods, never ipcRenderer itself or a
// generic invoke or send. A sandboxed preload can't require local files, so the method names, the channel
// scheme, and the progress channel repeat src/app/shared/api.ts; the compiler checks the list against VitalsApi.

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

const CHECKUP_PROGRESS_CHANNEL = 'vitals:checkup-progress';

const invokers = Object.fromEntries(
  METHODS.map((method) => [method, (arg?: unknown) => ipcRenderer.invoke(`vitals:${method}`, arg)]),
) as Pick<VitalsApi, InvokeMethod>;

const api: VitalsApi = {
  ...invokers,
  onCheckupProgress(listener) {
    // The IPC event carries the sender's internals; listeners get only the progress.
    const forward = (_event: IpcRendererEvent, progress: CheckupProgress) => listener(progress);
    ipcRenderer.on(CHECKUP_PROGRESS_CHANNEL, forward);
    return () => {
      ipcRenderer.removeListener(CHECKUP_PROGRESS_CHANNEL, forward);
    };
  },
};

contextBridge.exposeInMainWorld('vitals', api);
