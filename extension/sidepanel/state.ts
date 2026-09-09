import type { AgentState, AgentPhase } from './types';

export const initialState: AgentState = {
  phase: 'IDLE', page: null, task: null, detection: null,
  redaction: null, fields: [], outbound: null, pending: null, audit: [], error: null,
};

export type AgentEvent =
  | { type: 'PAGE'; page: AgentState['page'] }
  | { type: 'TASK_STARTED'; task: string }
  | { type: 'PHASE'; phase: AgentPhase }
  | { type: 'DETECTION'; detection: AgentState['detection'] }
  | { type: 'REDACTION'; redaction: AgentState['redaction']; fields: AgentState['fields'] }
  | { type: 'OUTBOUND'; outbound: AgentState['outbound'] }
  | { type: 'CONFIRM_REQUIRED'; pending: AgentState['pending'] }
  | { type: 'ACTION_RESOLVED'; entry: AuditLike }
  | { type: 'COMPLETE' }
  | { type: 'ERROR'; message: string }
  | { type: 'RESET' };

type AuditLike = AgentState['audit'][number];

const TERMINAL: AgentPhase[] = ['COMPLETE', 'REFUSED', 'ERROR'];
export const isTerminal = (p: AgentPhase) => TERMINAL.includes(p);
export const isBusy = (p: AgentPhase) =>
  p !== 'IDLE' && p !== 'AWAITING_CONFIRMATION' && !isTerminal(p);

export function reducer(state: AgentState, e: AgentEvent): AgentState {
  switch (e.type) {
    case 'PAGE': return { ...state, page: e.page };
    case 'TASK_STARTED': return { ...initialState, page: state.page, task: e.task, phase: 'CAPTURING' };
    // Any phase other than the wait itself means the question is settled;
    // drop the pending request so the dialog cannot be clicked twice.
    case 'PHASE': return {
      ...state, phase: e.phase,
      pending: e.phase === 'AWAITING_CONFIRMATION' ? state.pending : null,
    };
    case 'DETECTION': return { ...state, detection: e.detection };
    case 'REDACTION': return { ...state, redaction: e.redaction, fields: e.fields };
    case 'OUTBOUND': return { ...state, outbound: e.outbound };
    case 'CONFIRM_REQUIRED': return { ...state, phase: 'AWAITING_CONFIRMATION', pending: e.pending };
    case 'ACTION_RESOLVED': return {
      ...state, pending: null,
      audit: [e.entry, ...state.audit],
    };
    case 'COMPLETE': return { ...state, phase: 'COMPLETE', pending: null };
    case 'ERROR': return { ...state, phase: 'ERROR', pending: null, error: e.message };
    case 'RESET': return { ...initialState, page: state.page };
    default: return state;
  }
}

export const PHASE_LABEL: Record<AgentPhase, string> = {
  IDLE: 'Ready',
  CAPTURING: 'Inspecting this page',
  DETECTING: 'Detecting sensitive fields',
  REDACTING: 'Replacing values with references',
  BUILDING_SCENE: 'Preparing the outbound payload',
  PLANNING: 'Waiting for the planner',
  AWAITING_CONFIRMATION: 'Waiting for your approval',
  EXECUTING: 'Carrying out the approved action',
  COMPLETE: 'Task complete',
  REFUSED: 'Action refused',
  ERROR: 'Not completed',
};
