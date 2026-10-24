import { describe, it, expect, vi, beforeEach } from 'vitest';
import { INVOKE_METHODS, type VitalsApi } from '../../../src/app/shared/api.js';

type Listener = (...args: unknown[]) => void;

const electron = vi.hoisted(() => {
  const listeners = new Map<string, Set<Listener>>();
  return {
    listeners,
    contextBridge: { exposeInMainWorld: vi.fn() },
    ipcRenderer: {
      invoke: vi.fn(),
      on: vi.fn((channel: string, listener: Listener) => {
        listeners.set(channel, (listeners.get(channel) ?? new Set()).add(listener));
      }),
      removeListener: vi.fn((channel: string, listener: Listener) => { listeners.get(channel)?.delete(listener); }),
    },
  };
});
vi.mock('electron', () => ({ contextBridge: electron.contextBridge, ipcRenderer: electron.ipcRenderer }));

/** Main sending on `channel`, as Electron delivers it: the IPC event first. */
function send(channel: string, ...args: unknown[]): void {
  for (const listener of electron.listeners.get(channel) ?? []) listener({ sender: 'the IPC event' }, ...args);
}

beforeEach(async () => {
  vi.clearAllMocks();
  electron.listeners.clear();
  vi.resetModules();
  await import('../../../src/app/preload/preload.cts');
});

const exposedApi = () => electron.contextBridge.exposeInMainWorld.mock.calls[0]![1] as VitalsApi;

describe('preload', () => {
  it('exposes exactly the API as window.vitals', () => {
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(electron.contextBridge.exposeInMainWorld.mock.calls[0]![0]).toBe('vitals');
    expect(Object.keys(exposedApi()).sort()).toEqual([...INVOKE_METHODS, 'onCheckupProgress'].sort());
  });

  it('forwards each call on its own channel', async () => {
    const api = exposedApi();
    electron.ipcRenderer.invoke.mockResolvedValue('from main');
    const key = { snapshotId: 1, repoId: 2, number: 3 };
    await expect(api.getFinding(key)).resolves.toBe('from main');
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith('vitals:getFinding', key);

    for (const method of INVOKE_METHODS) {
      electron.ipcRenderer.invoke.mockClear();
      const arg = { for: method };
      await (api[method] as (arg: unknown) => Promise<unknown>)(arg);
      expect(electron.ipcRenderer.invoke, method).toHaveBeenCalledExactlyOnceWith(`vitals:${method}`, arg);
    }
  });

  it('progress listeners never see the IPC event and can unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = exposedApi().onCheckupProgress(listener);
    const progress = { done: 1, total: 3, repo: 'TETRA2000/a' };
    send('vitals:checkup-progress', progress);
    expect(listener.mock.calls).toEqual([[progress]]);

    unsubscribe();
    send('vitals:checkup-progress', { done: 2, total: 3, repo: 'TETRA2000/b' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(electron.listeners.get('vitals:checkup-progress')?.size).toBe(0);
  });
});
