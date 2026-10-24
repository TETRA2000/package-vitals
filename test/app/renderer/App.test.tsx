import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/app/renderer/App.js';
import { fakeApi, OVERVIEW } from './fake-api.js';

describe('App', () => {
  it('says there is no Checkup yet', async () => {
    const api = fakeApi({ getOverview: vi.fn(async () => ({ ...OVERVIEW, snapshot: null })) });
    render(<App api={api} />);
    expect(await screen.findByText('No Checkup yet. Run a Checkup to see your vitals.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Queue' })).not.toBeInTheDocument();
  });

  it('shows the snapshot it is reading', async () => {
    render(<App api={fakeApi()} />);
    expect(await screen.findByText('Snapshot 7 · TETRA2000 · completed 2026-10-24 05:07 UTC')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Queue' })).toBeInTheDocument();
  });

  it('switches views from the nav', async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi()} />);
    await screen.findByText(/Snapshot 7/);
    await user.click(screen.getByRole('button', { name: 'Repos' }));
    expect(screen.getByRole('heading', { name: 'Repos' })).toBeInTheDocument();
  });

  it('reloads the overview when the window regains focus', async () => {
    const api = fakeApi();
    render(<App api={api} />);
    await screen.findByText(/Snapshot 7/);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(api.getOverview).toHaveBeenCalledTimes(2);
  });

  it("shows an error when the overview can't load", async () => {
    const api = fakeApi({ getOverview: vi.fn(async () => { throw new Error('boom'); }) });
    render(<App api={api} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load data: boom");
  });
});
