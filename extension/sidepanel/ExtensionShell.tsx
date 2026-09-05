import React, { useReducer, useState, useCallback, useEffect } from 'react';
import { subscribe, startTask, sendDecision } from './bridge';
import { reducer, initialState, isBusy } from './state';
import { PageContext } from './components/PageContext';
import { AgentStatus } from './components/AgentStatus';
import { DetectionSummary } from './components/DetectionSummary';
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

  const start = useCallback(() => {
    const task = draft.trim();
    if (!task) return;
    dispatch({ type: 'TASK_STARTED', task });
    void startTask(task).catch(() =>
      dispatch({ type: 'ERROR', message: 'Could not reach the agent worker.' }));
  }, [draft]);

  useEffect(() => subscribe(dispatch), []);

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

  return (
    <main className="shell">
      <PageContext page={state.page} />
      <TabSwitcher tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'Activity' ? (
        <>
          <AgentStatus phase={state.phase} task={state.task} />
          {state.phase === 'IDLE' && (
            <Card>
              <label className="sub" htmlFor="task">What should the agent do?</label>
              <input id="task" value={draft} onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && start()}
                placeholder="Log me in"
                style={{
                  width: '100%', marginTop: 8, height: 44, border: 'none',
                  borderRadius: 12, background: 'var(--inner)', padding: '0 14px',
                  fontFamily: 'inherit', fontSize: 14, color: 'var(--text)',
                }} />
              <div style={{ marginTop: 10 }}>
                <PrimaryButton onClick={start} disabled={!draft.trim()}>Start task</PrimaryButton>
              </div>
            </Card>
          )}
          <DetectionSummary detection={state.detection} redaction={state.redaction} />
          <AuditSummary audit={state.audit} />
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
      <span className="sr-only" aria-live="polite">
        {isBusy(state.phase) ? 'Working' : 'Idle'}
      </span>
    </main>
  );
};
