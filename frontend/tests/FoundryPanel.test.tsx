import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FoundryPanel, { foundryPhaseIndex } from '../src/FoundryPanel';
import { foundryAction, foundryStatus, getLogs } from '../src/api';
vi.mock('../src/api', () => ({ foundryStatus: vi.fn(), foundryAction: vi.fn(), foundryCommand: vi.fn(), getLogs: vi.fn() }));
describe('Foundry session controls', () => {
  beforeEach(() => { sessionStorage.clear(); vi.clearAllMocks(); });
  it('offers launch when there is no paid runtime', async () => {
    vi.mocked(foundryStatus).mockResolvedValue({ configured: true, state: 'not-running' });
    vi.mocked(foundryAction).mockResolvedValue({ state: 'pending' });
    render(<FoundryPanel />);
    const start = await screen.findByRole('button', { name: 'Start Foundry' });
    expect(start).toBeEnabled(); expect(screen.getByRole('button', { name: 'Save and stop' })).toBeDisabled();
    await userEvent.click(start);
    expect(foundryAction).toHaveBeenCalledWith('start', 'on-demand');
    await waitFor(() => expect(start).toBeDisabled());
  });
  it('does not expose a launch button before deployment', async () => {
    vi.mocked(foundryStatus).mockResolvedValue({ configured: false }); render(<FoundryPanel />);
    expect(await screen.findByText('Foundry is not deployed yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start Foundry' })).not.toBeInTheDocument();
  });
  it('cancelling shutdown leaves the session running', async () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    vi.mocked(foundryStatus).mockResolvedValue({ configured: true, state: 'running', ready: true, url: 'https://example.cloudfront.net/' });
    render(<FoundryPanel />); await userEvent.click(await screen.findByRole('button', { name: 'Save and stop' }));
    expect(foundryAction).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Open Foundry' })).toHaveAttribute('href', 'https://example.cloudfront.net/');
  });
  it('launches on Spot when chosen', async () => {
    vi.mocked(foundryStatus).mockResolvedValue({ configured: true, state: 'not-running' });
    vi.mocked(foundryAction).mockResolvedValue({ state: 'pending' });
    render(<FoundryPanel />);
    await userEvent.click(await screen.findByRole('radio', { name: /Spot/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Start Foundry' }));
    expect(foundryAction).toHaveBeenCalledWith('start', 'spot');
  });
  it('shows launch phases and bootstrap logs while Foundry is preparing', async () => {
    vi.mocked(foundryStatus).mockResolvedValue({ configured: true, state: 'running', ready: false, instanceId: 'i-abc123', capacityType: 'spot' });
    vi.mocked(getLogs).mockImplementation(async (_id, type) => ({ lines: type === 'bootstrap'
      ? ['LAUNCH_PHASE phase=bootstrap label="Bootstrapping host" at=2026-09-27T18:00:00+00:00', 'LAUNCH_PHASE phase=install label="Installing Node.js and Foundry" at=2026-09-27T18:01:00+00:00']
      : ['\u001b[32minfo\u001b[39m Server started'] }));
    render(<FoundryPanel />);
    expect(await screen.findByText(/· Spot/)).toBeInTheDocument();
    const log = await screen.findByRole('log');
    await waitFor(() => expect(log).toHaveTextContent('LAUNCH_PHASE phase=install'));
    expect(screen.getAllByText('Installing Node.js and Foundry').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('tab', { name: 'Server log' }));
    expect(screen.getByRole('log')).toHaveTextContent('info Server started');
  });
});
describe('foundryPhaseIndex', () => {
  it('follows the furthest launch marker and completes when ready', () => {
    expect(foundryPhaseIndex([], false)).toBe(0);
    expect(foundryPhaseIndex(['LAUNCH_PHASE phase=network label="x"', 'LAUNCH_PHASE phase=files label="y"'], false)).toBe(6);
    expect(foundryPhaseIndex([], true)).toBe(7);
  });
});
