import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import InstanceDetailTabs, { type InstanceDetailTab } from '../src/InstanceDetailTabs';

function Harness() {
  const [active, setActive] = useState<InstanceDetailTab>('overview');
  return (
    <>
      <InstanceDetailTabs activeTab={active} onChange={setActive} />
      <div id="instance-detail-panel" role="tabpanel" aria-labelledby={`instance-tab-${active}`}>{active}</div>
    </>
  );
}

describe('InstanceDetailTabs', () => {
  it('renders stable ARIA controls and changes the mounted panel', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(5);
    tabs.forEach((tab) => expect(tab).toHaveAttribute('aria-controls', 'instance-detail-panel'));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('overview');
    await user.click(screen.getByRole('tab', { name: 'Server Logs' }));
    expect(screen.getByRole('tab', { name: 'Server Logs' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('server-logs');
  });

  it('supports wrapped arrows plus Home and End keyboard navigation', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const overview = screen.getByRole('tab', { name: 'Overview' });
    overview.focus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Config' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(overview).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Config' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(overview).toHaveFocus();
    fireEvent.keyDown(overview, { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
  });
});
