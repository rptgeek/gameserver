import React from 'react';

export function AdvancedConfigDisclosure({ open, attentionRequired, onOpenChange, children }: {
  open: boolean;
  attentionRequired: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <details
      className="disclosure launch-options"
      open={open || attentionRequired}
      onToggle={(event) => {
        if (attentionRequired && !event.currentTarget.open) {
          event.currentTarget.open = true;
          return;
        }
        if (!attentionRequired) onOpenChange(event.currentTarget.open);
      }}
    >
      <summary>Advanced game-server configuration</summary>
      <div className="launch-options-content">{children}</div>
    </details>
  );
}

export function LaunchStartButton({ label, disabledReason, onClick }: {
  label: string;
  disabledReason: string;
  onClick: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="btn btn-success"
        onClick={onClick}
        disabled={Boolean(disabledReason)}
        aria-describedby={disabledReason ? 'start-instance-disabled-reason' : undefined}
      >
        {label}
      </button>
      {disabledReason && <p id="start-instance-disabled-reason" className="launch-disabled-reason" role="status">{disabledReason}</p>}
    </>
  );
}
