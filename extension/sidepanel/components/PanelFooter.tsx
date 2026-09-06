import React from 'react';

export const PanelFooter: React.FC<{ onTab: (t: string) => void; active: string; show: boolean }> = ({ onTab, active, show }) => (
  <footer className="panel-footer">
    {show && (
      <div className="chip-row">
        <button className="chip" onClick={() => onTab(active === 'Payload' ? 'Activity' : 'Payload')}>
          {active === 'Payload' ? 'Back to activity' : 'Inspect payload'}
        </button>
      </div>
    )}
    <span className="footer-note">Perception stays on this device</span>
  </footer>
);
