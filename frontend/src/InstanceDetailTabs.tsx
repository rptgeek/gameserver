import React from 'react';
import { nextTabIndex } from './uiSemantics';

export type InstanceDetailTab = 'overview' | 'bootstrap-logs' | 'server-logs' | 'console' | 'config';

const TABS: Array<{ id: InstanceDetailTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'bootstrap-logs', label: 'Bootstrap Logs' },
  { id: 'server-logs', label: 'Server Logs' },
  { id: 'console', label: 'Console' },
  { id: 'config', label: 'Config' },
];

export default function InstanceDetailTabs({ activeTab, onChange }: { activeTab: InstanceDetailTab; onChange: (tab: InstanceDetailTab) => void }) {
  return (
    <div
      className="tabs"
      role="tablist"
      aria-label="Instance details"
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const target = event.target as HTMLElement;
        if (target.getAttribute('role') !== 'tab') return;
        event.preventDefault();
        const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
        const nextIndex = nextTabIndex(tabs.indexOf(target as HTMLButtonElement), event.key, tabs.length);
        tabs[nextIndex]?.focus();
        tabs[nextIndex]?.click();
      }}
    >
      {TABS.map((tab) => (
        <button
          key={tab.id}
          id={`instance-tab-${tab.id}`}
          role="tab"
          aria-controls="instance-detail-panel"
          aria-selected={activeTab === tab.id}
          tabIndex={activeTab === tab.id ? 0 : -1}
          type="button"
          className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
