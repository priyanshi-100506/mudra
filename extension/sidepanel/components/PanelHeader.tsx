import React from 'react';
import { Lockup } from './Lockup';

export const PanelHeader: React.FC<{ onReset: () => void; busy: boolean }> = ({ onReset, busy }) => (
  <header className="panel-header">
    <div className="brand">
      <Lockup height={28} />
    </div>
    <div className="header-actions">
      <button className="icon-btn" onClick={onReset} aria-label="Start over" disabled={busy}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" />
        </svg>
      </button>
    </div>
  </header>
);
