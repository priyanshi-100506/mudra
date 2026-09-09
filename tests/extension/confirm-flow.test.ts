import { describe, it, expect } from 'vitest';
import { reducer, initialState } from '../../extension/sidepanel/state';
import type { AgentState } from '../../extension/sidepanel/state';

const pending = {
  sentence: 'Submit this form on bank.example.in?',
  origin: 'https://bank.example.in',
  effect: 'submit_form',
  targetRole: 'ref_je08jp12cq',
  targetRef: 'ref_je08jp12cq',
};

const awaiting = (): AgentState =>
  reducer(initialState, { type: 'CONFIRM_REQUIRED', pending });

describe('the confirmation dialog is asked once and settles once', () => {
  it('raises the dialog and parks in AWAITING_CONFIRMATION', () => {
    const s = awaiting();
    expect(s.phase).toBe('AWAITING_CONFIRMATION');
    expect(s.pending).toEqual(pending);
  });

  it('drops the dialog the moment the phase moves on', () => {
    // Regression: `pending` used to clear only on ACTION_RESOLVED, so the
    // dialog stayed on screen for the whole of EXECUTING. Users read the
    // still-present dialog as "my click did nothing" and clicked again.
    const s = reducer(awaiting(), { type: 'PHASE', phase: 'EXECUTING' });
    expect(s.pending).toBeNull();
  });

  it('drops the dialog when the action is refused', () => {
    const s = reducer(awaiting(), { type: 'PHASE', phase: 'REFUSED' });
    expect(s.pending).toBeNull();
  });

  it('keeps the dialog while the question is genuinely still open', () => {
    const s = reducer(awaiting(), { type: 'PHASE', phase: 'AWAITING_CONFIRMATION' });
    expect(s.pending).toEqual(pending);
  });

  it('clears the dialog on completion and on error', () => {
    expect(reducer(awaiting(), { type: 'COMPLETE' }).pending).toBeNull();
    expect(reducer(awaiting(), { type: 'ERROR', message: 'boom' }).pending).toBeNull();
  });

  it('a resolved action leaves nothing pending behind', () => {
    const s = reducer(awaiting(), {
      type: 'ACTION_RESOLVED',
      entry: { effect: 'submit_form', outcome: 'executed' },
    } as never);
    expect(s.pending).toBeNull();
  });
});
