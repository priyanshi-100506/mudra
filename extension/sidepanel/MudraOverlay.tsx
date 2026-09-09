import React, { useReducer, useState, useEffect, useCallback, useRef } from 'react';
import { Lockup } from './components/Lockup';
import { subscribe, startTask, sendDecision } from './bridge';
import { reducer, initialState, isBusy, isTerminal, PHASE_LABEL } from './state';
import type { RedactedField } from '../src/shared/agent-events';

const MAX = 300;

const Reel: React.FC<{ fields: RedactedField[] }> = ({ fields }) => {
  const [sealed, setSealed] = useState(0);
  useEffect(() => {
    setSealed(0);
    if (!fields.length) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setSealed(fields.length);
      return;
    }
    const t = fields.map((_, i) => window.setTimeout(() => setSealed(i + 1), 260 + i * 240));
    return () => t.forEach(clearTimeout);
  }, [fields]);

  if (!fields.length) return null;
  return (
    <div className="mudra-reel">
      {fields.map((f, i) => (
        <div key={f.ref}
          className={`mudra-field${i < sealed && f.sensitive ? ' sealed' : ''}`}
          style={{ animationDelay: `${i * 55}ms` }}>
          <span className="mudra-flabel">{f.label}</span>
          {f.sensitive ? (
            <>
              <span className="mudra-arrow" aria-hidden="true">→</span>
              <code className="mudra-ref">{f.ref}</code>
            </>
          ) : <span className="mudra-safe">not sensitive</span>}
        </div>
      ))}
    </div>
  );
};

export const MudraOverlay: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [draft, setDraft] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => subscribe(dispatch), []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const start = useCallback(() => {
    const task = draft.trim();
    if (!task) return;
    dispatch({ type: 'TASK_STARTED', task });
    void startTask(task).catch(() =>
      dispatch({ type: 'ERROR', message: 'Could not reach the agent worker.' }));
  }, [draft]);

  const idle = state.phase === 'IDLE';
  const done = isTerminal(state.phase);
  const o = state.outbound;

  return (
    <div className="mudra-root" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className="mudra-card" role="dialog" aria-modal="true" aria-label="Mudra"
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="mudra-head">
          <div>
            <Lockup variant="dark" height={26} className="mudra-brand-lockup" />
            <p className="mudra-tag">every value is sealed before it leaves.</p>
          </div>
          <button className="mudra-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <hr className="mudra-rule" />

        {idle ? (
          <>
            <h2 className="mudra-q">What do you need?</h2>
            <textarea className="mudra-input" value={draft} maxLength={MAX}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start(); }}
              placeholder="Tell Mudra what you want done on this page…" autoFocus />
            <div className="mudra-actions">
              <span className="mudra-count">{draft.length}/{MAX}</span>
              <button className="mudra-btn" onClick={start} disabled={!draft.trim()}>Start</button>
            </div>
            <p className="mudra-foot">
              Perception runs on this device. The planner sees references, never values.
            </p>
          </>
        ) : (
          <>
            <span className="mudra-status">
              {isBusy(state.phase) && <span className="mudra-dot" aria-hidden="true" />}
              {PHASE_LABEL[state.phase]}
            </span>

            <Reel fields={state.fields} />

            {state.fields.length > 0 && (
              <div className="mudra-boundary">
                <span className="mudra-bline" />
                <span className="mudra-blabel">leaves the device</span>
                <span className="mudra-bline" />
              </div>
            )}

            {o && (
              <div className="mudra-stats">
                <div className="mudra-stat">
                  <div className="mudra-num zero">{o.rawPixelsSent}</div>
                  <div className="mudra-slabel">raw pixels sent</div>
                </div>
                <div className="mudra-stat">
                  <div className="mudra-num zero">{o.piiValuesSent}</div>
                  <div className="mudra-slabel">values sent</div>
                </div>
                <div className="mudra-stat">
                  <div className="mudra-num">{o.fieldsDescribed}</div>
                  <div className="mudra-slabel">fields described</div>
                </div>
              </div>
            )}

            {state.error && <div className="mudra-err">{state.error}</div>}

            {done && (
              <div className="mudra-actions" style={{ marginTop: 18 }}>
                <button className="mudra-btn mudra-btn-ghost"
                  onClick={() => { setDraft(''); dispatch({ type: 'RESET' }); }}>
                  New task
                </button>
                <button className="mudra-btn" onClick={onClose}>Close</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
