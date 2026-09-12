import React, { useReducer, useState, useCallback, useEffect } from 'react';
import { subscribe, startTask, sendDecision, stopTask } from './bridge';
import { reducer, initialState } from './state';
import { LivePanel } from './components/LivePanel';
import { ConfirmationDialog } from './components/ConfirmationDialog';
import { ErrorState } from './components/ErrorState';
import { Hero } from './components/Hero';
import { PrimaryButton } from './components/primitives';

export const ExtensionShell: React.FC = () => {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [draft, setDraft] = useState('');

  useEffect(() => subscribe(dispatch), []);

  const start = useCallback(() => {
    const task = draft.trim();
    if (!task) return;
    dispatch({ type: 'TASK_STARTED', task });
    void startTask(task).catch(() =>
      dispatch({ type: 'ERROR', message: 'Could not reach the agent worker.' }));
  }, [draft]);

  const reset = useCallback(() => {
    setDraft('');
    dispatch({ type: 'RESET' });
    void stopTask().catch(() => {});
  }, []);

  const resolve = (decision: 'authorise' | 'refuse') => {
    if (!state.pending) return;
    dispatch({ type: 'PHASE', phase: decision === 'refuse' ? 'REFUSED' : 'CAPTURING' });
    void sendDecision(decision).catch(() =>
      dispatch({ type: 'ERROR', message: 'Could not send your decision to the executor.' }));
  };

  if (state.phase === 'ERROR') {
    return (
      <main className="shell">
        <ErrorState message={state.error ?? 'Unknown error.'} onRetry={reset} />
      </main>
    );
  }

  // Before a run there is nothing to monitor, so the panel is not shown. The
  // authorisation dialog belongs to this moment — before the page is read —
  // and the shell cannot render it at any other point.
  if (state.phase === 'IDLE' && !state.pending) {
    return (
      <main className="shell">
        <Hero origin={state.page?.origin ?? null} title={state.page?.title ?? null} />
        <div className="idle-task">
          <label className="h2" htmlFor="task">What should the agent do?</label>
          <input
            id="task"
            className="field-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') start(); }}
            placeholder="Log me in"
          />
          <div style={{ marginTop: 10 }}>
            <PrimaryButton onClick={start} disabled={!draft.trim()}>Start task</PrimaryButton>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="shell">
      <LivePanel state={state} onReset={reset} />
      {state.pending && (
        <ConfirmationDialog
          pending={state.pending}
          onAuthorise={() => resolve('authorise')}
          onRefuse={() => resolve('refuse')}
        />
      )}
    </main>
  );
};
