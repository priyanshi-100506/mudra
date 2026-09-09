import React, { useReducer, useState, useEffect, useCallback } from 'react';
import { subscribe, startTask, sendDecision } from '../../sidepanel/bridge';
import { ConfirmDialog } from './ConfirmDialog';
import { Lockup } from '../../sidepanel/components/Lockup';
import { reducer, initialState, isBusy, isTerminal, PHASE_LABEL } from '../../sidepanel/state';
import type { RedactedField } from '../shared/agent-events';

const MAX = 300;
const TABS = ['Task', 'Payload'] as const;

const Reel: React.FC<{ fields: RedactedField[] }> = ({ fields }) => {
  const [sealed, setSealed] = useState(0);
  useEffect(() => {
    setSealed(0);
    if (!fields.length) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setSealed(fields.length);
      return;
    }
    const t = fields.map((_, i) => window.setTimeout(() => setSealed(i + 1), 220 + i * 200));
    return () => t.forEach(clearTimeout);
  }, [fields]);

  if (!fields.length) return null;
  return (
    <div className="mudra-reel">
      {fields.slice(0, 6).map((f, i) => (
        <div key={f.ref}
          className={`mudra-field${i < sealed && f.sensitive ? ' sealed' : ''}`}
          style={{ animationDelay: `${i * 50}ms` }}>
          <span className="mudra-flabel">{f.label}</span>
          {f.sensitive ? (
            <>
              <span className="mudra-arrow" aria-hidden="true">→</span>
              <code className="mudra-ref">{f.ref}</code>
            </>
          ) : <span className="mudra-safe">safe</span>}
        </div>
      ))}
    </div>
  );
};

export const MudraPopup: React.FC = () => {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState<string>(TABS[0]);

  useEffect(() => subscribe(dispatch), []);

  const start = useCallback(() => {
    const task = draft.trim();
    if (!task) return;
    dispatch({ type: 'TASK_STARTED', task });
    void startTask(task).catch(() =>
      dispatch({ type: 'ERROR', message: 'Could not reach the agent worker.' }));
  }, [draft]);

  const reset = () => { setDraft(''); setTab(TABS[0]); dispatch({ type: 'RESET' }); };

  const decide = (decision: 'authorise' | 'refuse') => {
    void sendDecision(decision).catch(() =>
      dispatch({ type: 'ERROR', message: 'Could not send your decision to the executor.' }));
  };

  const idle = state.phase === 'IDLE';
  const done = isTerminal(state.phase);
  const o = state.outbound;

  return (
    <div className="mudra-frame">
      <div className="mudra-topbar">
        <div className="mudra-id">
          <div>
            {/* The lockup carries the wordmark, so no separate name label. */}
            <Lockup height={30} className="mudra-lockup" />
            <p className="mudra-sub">{state.page?.origin ?? 'on-device perception'}</p>
          </div>
        </div>
        <div className="mudra-tools">
          <button className="mudra-tool" onClick={reset} aria-label="Start over" disabled={isBusy(state.phase)}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" />
            </svg>
          </button>
        </div>
      </div>

      <div className="mudra-body">
        {!idle && (
          <div className="mudra-tabs" role="tablist" aria-label="View">
            {TABS.map((t) => (
              <button key={t} role="tab" className="mudra-tab" aria-selected={t === tab}
                tabIndex={t === tab ? 0 : -1} onClick={() => setTab(t)}>{t}</button>
            ))}
          </div>
        )}

        {idle ? (
          <>
            <div className="mudra-welcome">
              <p className="mudra-hi">Welcome to <em>Mudra</em></p>
              <p className="mudra-hi-sub">
                Tell it what you want done on this page. Sensitive values are
                sealed into references before anything leaves this device.
              </p>
            </div>
            <h2 className="mudra-q">What do you need?</h2>
            <textarea className="mudra-input" value={draft} maxLength={MAX}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); start(); } }}
              placeholder="Tell Mudra what you want done…" autoFocus />
            <div className="mudra-actions"><span className="mudra-count">{draft.length}/{MAX}</span></div>
            <div style={{ marginTop: 8 }}>
              <button className="mudra-btn" onClick={start} disabled={!draft.trim()}>Start task</button>
            </div>
          </>
        ) : tab === 'Task' ? (
          <>
            <div className="mudra-status">
              {isBusy(state.phase) && <span className="mudra-dot" aria-hidden="true" />}
              {PHASE_LABEL[state.phase]}
            </div>
            <Reel fields={state.fields} />
            {state.fields.length > 0 && (
              <div className="mudra-boundary">
                <span className="mudra-bline" />
                <span className="mudra-blabel">leaves the device</span>
                <span className="mudra-bline" />
              </div>
            )}
            {state.error && <div className="mudra-err">{state.error}</div>}

            {state.audit.length > 0 && (
              <div className="mudra-audit">
                <p className="mudra-audit-head">What happened</p>
                {state.audit.map((a, i) => (
                  <div key={`${a.at}-${i}`}>
                    <div className="mudra-audit-row">
                      <span className="mudra-audit-effect">{a.effect}</span>
                      <span className={`mudra-audit-mark ${a.outcome}`}>{a.outcome}</span>
                    </div>
                    {a.reason && <p className="mudra-audit-reason">{a.reason}</p>}
                  </div>
                ))}
              </div>
            )}
            {done && (
              <div style={{ marginTop: 13 }}>
                <button className="mudra-btn mudra-btn-ghost" onClick={reset}>New task</button>
              </div>
            )}
          </>
        ) : (
          <>
            {o ? (
              <>
                <div className="mudra-stats">
                  <div className="mudra-stat">
                    <div className="mudra-num zero">{o.rawPixelsSent}</div>
                    <div className="mudra-slabel">pixels</div>
                  </div>
                  <div className="mudra-stat">
                    <div className="mudra-num zero">{o.piiValuesSent}</div>
                    <div className="mudra-slabel">values</div>
                  </div>
                  <div className="mudra-stat">
                    <div className="mudra-num">{o.fieldsDescribed}</div>
                    <div className="mudra-slabel">fields</div>
                  </div>
                </div>
                <p className="mudra-notice" style={{ margin: '14px 0 0' }}>
                  <span className="mudra-notice-dot" aria-hidden="true" />
                  This is everything the planner receives. No values, no raw pixels.
                </p>
              </>
            ) : (
              <p className="mudra-sub" style={{ padding: '8px 0' }}>Nothing prepared to send yet.</p>
            )}
          </>
        )}
      </div>


      {state.pending && (
        <ConfirmDialog
          pending={state.pending}
          onAuthorise={() => decide('authorise')}
          onRefuse={() => decide('refuse')}
        />
      )}
    </div>
  );
};
