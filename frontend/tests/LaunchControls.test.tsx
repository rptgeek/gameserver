import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AdvancedConfigDisclosure, LaunchStartButton } from '../src/LaunchControls';

describe('launch controls', () => {
  it('opens required advanced configuration and prevents dismissing it while attention is required', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <AdvancedConfigDisclosure open={false} attentionRequired={true} onOpenChange={onOpenChange}>
        <p>Invalid XML</p>
      </AdvancedConfigDisclosure>,
    );
    const disclosure = screen.getByText('Advanced game-server configuration').closest('details');
    expect(disclosure).toHaveAttribute('open');
    await user.click(screen.getByText('Advanced game-server configuration'));
    expect(disclosure).toHaveAttribute('open');
    expect(onOpenChange).not.toHaveBeenCalled();

    rerender(
      <AdvancedConfigDisclosure open={false} attentionRequired={false} onOpenChange={onOpenChange}>
        <p>Valid configuration</p>
      </AdvancedConfigDisclosure>,
    );
    fireEvent(disclosure!, new Event('toggle'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows a visible adjacent reason for disabled Start and allows enabled submission', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { rerender } = render(<LaunchStartButton label="Start AWS instance" disabledReason="Select a saved world." onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Start AWS instance' });
    const reason = screen.getByRole('status');
    expect(button).toBeDisabled();
    expect(reason).toHaveTextContent('Select a saved world.');
    expect(button).toHaveAccessibleDescription('Select a saved world.');

    rerender(<LaunchStartButton label="Start AWS instance" disabledReason="" onClick={onClick} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start AWS instance' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
