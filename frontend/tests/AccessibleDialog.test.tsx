import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import AccessibleDialog from '../src/AccessibleDialog';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open launch setup</button>
      {open && (
        <AccessibleDialog labelledBy="dialog-title" describedBy="dialog-description" onClose={() => setOpen(false)}>
          <div>
            <h2 id="dialog-title">Start an AWS instance</h2>
            <p id="dialog-description">Launch settings</p>
            <button data-autofocus onClick={() => setOpen(false)}>Close</button>
            <input aria-label="World name" />
          </div>
        </AccessibleDialog>
      )}
    </>
  );
}

describe('AccessibleDialog', () => {
  it('names the dialog, focuses it, traps Tab, closes with Escape, and returns focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open launch setup' });
    await user.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Start an AWS instance' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Launch settings');
    const close = screen.getByRole('button', { name: 'Close' });
    const input = screen.getByRole('textbox', { name: 'World name' });
    expect(close).toHaveFocus();

    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(input).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('contains Tab even when a dialog has no focusable descendants', () => {
    render(<AccessibleDialog labelledBy="empty-title" onClose={() => undefined}><h2 id="empty-title">Empty</h2></AccessibleDialog>);
    const dialog = screen.getByRole('dialog', { name: 'Empty' });
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    dialog.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Enter' });
  });
});
