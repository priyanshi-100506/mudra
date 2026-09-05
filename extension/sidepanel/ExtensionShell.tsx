import React, { useReducer, useState, useCallback, useEffect } from 'react';
import { subscribe, startTask, sendDecision } from './bridge';
import { reducer, initialState, isBusy, isTerminal } from './state';
import { Hero } from './components/Hero';
import { PageContext } from './components/PageContext';
import { AgentStatus } from './components/AgentStatus';
import { RedactionReel } from './components/RedactionReel';
import { OutboundPayload } from './components/OutboundPayload';
import { ConfirmationDialog } from './components/ConfirmationDialog';
import { AuditSummary } from './components/AuditSummary';
import { ErrorState } from './components/ErrorState';
import { TabSwitcher, Card, PrimaryButton } from './components/primitives';

const TABS = ['Activity', 'Payload'] as const;

export const ExtensionShell: React.FC = () => {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [tab, setTab] = useState<string>(TABS[0]);
  const [draft, setDraft] = useState('');

  useEffect(() => subscribe(dispatch), []);

  const start = useCallback(() => {
    const task = draft.trim();
    if (!task) return;
    dispatch({ type: 'TASK_STARTED', task });
    void startTask(task).catch(() =>
      dispatch({ type: 'ERROR', message: 'Could not reach the agent worker.' }));
  }, [draft]);

  const resolve = (decision: 'authorise' | 'refuse') => {
    if (!state.pending) return;
    dispatch({ type: 'PHASE', phase: decision === 'refuse' ? 'REFUSED' : 'EXECUTING' });
    void sendDecision(decision).catch(() =>
      dispatch({ type: 'ERROR', message: 'Could not send your decision to the executor.' }));
  };

  if (state.phase === 'ERROR') {
    return (
      <main className="shell">
        <PageContext page={state.page} />
        <ErrorState message={state.error ?? 'Unknown error.'} onRetry={() => dispatch({ type: 'RESET' })} />
      </main>
    );
  }

  const idle = state.phase === 'IDLE';

  return (
    <main className="shell">
      {idle
        ? <Hero origin={state.page?.origin ?? null} title={state.page?.title ?? null} />
        : <PageContext page={state.page} />}

      {!idle && <TabSwitcher tabs={TABS} active={tab} onChange={setTab} />}

      {idle ? (
        <Card>
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
        </Card>
      ) : tab === 'Activity' ? (
        <>
          <AgentStatus phase={state.phase} task={state.task} />
          <RedactionReel fields={state.fields} outboundReady={state.outbound !== null} />
          <AuditSummary audit={state.audit} />
          {isTerminal(state.phase) && (
            <Card>
              <PrimaryButton onClick={() => { setDraft(''); dispatch({ type: 'RESET' }); }}>
                New task
              </PrimaryButton>
            </Card>
          )}
        </>
      ) : (
        <OutboundPayload outbound={state.outbound} />
      )}

      {state.pending && (
        <ConfirmationDialog
          pending={state.pending}
          onAuthorise={() => resolve('authorise')}
          onRefuse={() => resolve('refuse')}
        />
      )}

      <span className="sr-only" aria-live="polite">{isBusy(state.phase) ? 'Working' : 'Idle'}</span>
    </main>
  );
};
