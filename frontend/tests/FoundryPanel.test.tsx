import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FoundryPanel from '../src/FoundryPanel';
import { foundryAction, foundryStatus } from '../src/api';
vi.mock('../src/api', () => ({ foundryStatus: vi.fn(), foundryAction: vi.fn(), foundryCommand: vi.fn() }));
describe('Foundry session controls', () => {
  beforeEach(() => { sessionStorage.clear(); vi.clearAllMocks(); });
  it('offers launch when there is no paid runtime', async () => {
    vi.mocked(foundryStatus).mockResolvedValue({ configured: true, state: 'not-running' });
    vi.mocked(foundryAction).mockResolvedValue({ state: 'pending' });
    render(<FoundryPanel />);
    const start = await screen.findByRole('button', { name: 'Start Foundry' });
    expect(start).toBeEnabled(); expect(screen.getByRole('button', { name: 'Save and stop' })).toBeDisabled();
    await userEvent.click(start);
    expect(foundryAction).toHaveBeenCalledWith('start');
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
});
