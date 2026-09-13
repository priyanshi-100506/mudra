import React, { useReducer, useCallback, useEffect } from 'react';
import { subscribe, startTask, sendDecision, stopTask } from './bridge';
import { reducer, initialState } from './state';
import { LivePanel } from './components/LivePanel';
import { ConfirmationDialog } from './components/ConfirmationDialog';
import { ErrorState } from './components/ErrorState';
import { EntryScreen } from './components/EntryScreen';

export const ExtensionShell: React.FC = () => {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => subscribe(dispatch), []);

  const start = useCallback((task: string) => {
    dispatch({ type: 'TASK_STARTED', task });
    void startTask(task).catch(() =>
      dispatch({ type: 'ERROR', message: 'Could not reach the agent worker.' }));
  }, []);

  const reset = useCallback(() => {
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

  // Before a run there is nothing to monitor, so the panel gives way to the
  // entry screen. The authorisation dialog belongs to this moment — before
  // the page is read — and the shell cannot render it at any other point.
  if (state.phase === 'IDLE' && !state.pending) {
    return (
      <main className="panel-host">
        <EntryScreen origin={state.page?.origin ?? null} onStart={start} />
      </main>
    );
  }

  return (
    <main className="panel-host">
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
