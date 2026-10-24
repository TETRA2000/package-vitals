import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CheckupButton } from '../../../src/app/renderer/components/CheckupButton.js';
import type { CheckupProgress, CheckupResult } from '../../../src/app/shared/api.js';
import { fakeApi } from './fake-api.js';

const SUMMARY = { snapshotId: 8, reposChecked: 2, notMonitored: 1, errors: 1, open: { critical: 1, high: 0, medium: 0, low: 0 } };

describe('CheckupButton', () => {
  it('runs a Checkup and shows progress and the summary', async () => {
    const user = userEvent.setup();
    let emit: (p: CheckupProgress) => void = () => {};
    let finish: (r: CheckupResult) => void = () => {};
    const api = fakeApi({
      onCheckupProgress: vi.fn((l) => { emit = l; return () => {}; }),
      startCheckup: vi.fn(() => new Promise<CheckupResult>((res) => { finish = res; })),
    });
    const onSettled = vi.fn();
    render(<CheckupButton api={api} running={false} onSettled={onSettled} />);
    await user.click(screen.getByRole('button', { name: 'Run Checkup' }));
    act(() => emit({ done: 1, total: 2, repo: 'TETRA2000/<b>a</b>' }));
    const busy = screen.getByRole('button', { name: 'Checking… 1 / 2 · TETRA2000/<b>a</b>' });
    expect(busy).toBeDisabled();
    await act(async () => finish({ ok: true, summary: SUMMARY }));
    expect(screen.getByText(/^Checked 2 repos: 1 critical, 0 high, 0 medium, 0 low open alerts\. 1 not monitored, 1 with errors\. Snapshot 8\.$/))
      .toBeInTheDocument();
    expect(screen.getByText("Warning: alerts for 1 repo couldn't be read and aren't counted. Run the checkup again to retry.")).toBeInTheDocument();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Run Checkup' })).toBeEnabled();
  });

  it('shows a failure and lets the owner try again', async () => {
    const user = userEvent.setup();
    const startCheckup = vi.fn<() => Promise<CheckupResult>>()
      .mockResolvedValueOnce({ ok: false, message: 'GitHub CLI (gh) is not installed.' })
      .mockResolvedValueOnce({ ok: true, summary: { ...SUMMARY, errors: 0 } });
    const onSettled = vi.fn();
    render(<CheckupButton api={fakeApi({ startCheckup })} running={false} onSettled={onSettled} />);
    await user.click(screen.getByRole('button', { name: 'Run Checkup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('GitHub CLI (gh) is not installed.');
    expect(onSettled).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Run Checkup' }));
    expect(await screen.findByText(/Snapshot 8\./)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('stays disabled while another Checkup runs', () => {
    render(<CheckupButton api={fakeApi()} running onSettled={() => {}} />);
    expect(screen.getByRole('button', { name: 'Checkup running…' })).toBeDisabled();
  });

  it('unsubscribes from progress on unmount', () => {
    const unsubscribe = vi.fn();
    const api = fakeApi({ onCheckupProgress: vi.fn(() => unsubscribe) });
    const { unmount } = render(<CheckupButton api={api} running={false} onSettled={() => {}} />);
    expect(unsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
