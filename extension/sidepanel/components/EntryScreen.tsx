import React, { useState } from 'react';
import { MarkIcon } from './icons';

const MAX = 300;

/**
 * The entry screen: what the panel shows before a run.
 *
 * It shares the panel's header so opening the extension and starting a task
 * feel like one surface rather than two, and it states the guarantee up front
 * — before the user has typed anything, and long before the authorisation
 * dialog asks them to agree to it.
 */
export const EntryScreen: React.FC<{
  origin: string | null;
  onStart: (task: string) => void;
}> = ({ origin, onStart }) => {
  const [draft, setDraft] = useState('');
  const ready = draft.trim().length > 0;

  const start = () => { if (ready) onStart(draft.trim()); };

  return (
    <div className="lp lp-entry">
      <header className="lp-head">
        <span className="lp-mark"><MarkIcon /></span>
        <span className="lp-word">Mudra</span>
      </header>

      <div className="lp-entry-body">
        <p className="lp-hi">Welcome to <em>Mudra</em></p>
        <p className="lp-hi-sub">
          Tell it what you want done on this page. Sensitive values are sealed
          into references before anything leaves this device.
        </p>

        <h2 className="lp-q">What do you need?</h2>
        <textarea
          className="lp-input"
          value={draft}
          maxLength={MAX}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); start(); }
          }}
          placeholder="Tell Mudra what you want done…"
          autoFocus
        />
        <div className="lp-entry-meta">
          <span className="lp-count">{draft.length}/{MAX}</span>
          {origin && <span className="lp-origin">{origin}</span>}
        </div>

        <button className="lp-start" onClick={start} disabled={!ready}>Start task</button>
      </div>
    </div>
  );
};
