import type {
  AgentState, AgentPhase, EventMeta, FeedItem, StageName, StageState,
} from './types';
import type { ManifestLine } from '../src/shared/agent-events';

/** The feed is the only unbounded structure here; oldest rows drop out. */
export const FEED_CAP = 200;

export const initialState: AgentState = {
  phase: 'IDLE', page: null, task: null, detection: null,
  redaction: null, fields: [], outbound: null, pending: null, audit: [], error: null,
  feed: [], observed: null, seen: [], refused: 0,
};

export type AgentEvent =
  | { type: 'PAGE'; page: AgentState['page']; meta?: EventMeta }
  | { type: 'TASK_STARTED'; task: string }
  | { type: 'PHASE'; phase: AgentPhase; meta?: EventMeta }
  | { type: 'OBSERVED'; elements: number; sensitive: number; meta?: EventMeta }
  | { type: 'DETECTION'; detection: AgentState['detection']; meta?: EventMeta }
  | { type: 'REDACTION'; redaction: AgentState['redaction']; fields: AgentState['fields']; meta?: EventMeta }
  | { type: 'OUTBOUND'; outbound: AgentState['outbound']; meta?: EventMeta }
  | { type: 'CONFIRM_REQUIRED'; pending: AgentState['pending']; meta?: EventMeta }
  | { type: 'ACTION_RESOLVED'; entry: AuditLike; meta?: EventMeta }
  | { type: 'MANIFEST'; entries: ManifestLine[]; meta?: EventMeta }
  | { type: 'COMPLETE'; meta?: EventMeta }
  | { type: 'ERROR'; message: string; meta?: EventMeta }
  | { type: 'RESET' };

type AuditLike = AgentState['audit'][number];

const TERMINAL: AgentPhase[] = ['COMPLETE', 'REFUSED', 'ERROR'];
export const isTerminal = (p: AgentPhase) => TERMINAL.includes(p);
export const isBusy = (p: AgentPhase) =>
  p !== 'IDLE' && p !== 'AWAITING_CONFIRMATION' && !isTerminal(p);

// ── feed helpers ───────────────────────────────────────────────────────────

function append(state: AgentState, rows: Omit<FeedItem, 'id' | 'at' | 'replay'>[],
                meta: EventMeta | undefined): FeedItem[] {
  const at = meta?.at ?? new Date().toISOString();
  const replay = meta?.replay === true;
  const base = meta?.seq ?? 0;
  const next = rows.map((r, i) => ({ ...r, id: `${base}:${i}`, at, replay }));
  const feed = [...state.feed, ...next];
  return feed.length > FEED_CAP ? feed.slice(feed.length - FEED_CAP) : feed;
}

/**
 * The worker replays its whole history whenever a panel reconnects, so every
 * fold is guarded on the emitter's `seq`. Without this a reopened panel would
 * re-append the feed and double the counters.
 */
function alreadySeen(state: AgentState, meta?: EventMeta): boolean {
  return meta?.seq !== undefined && state.seen.includes(meta.seq);
}

function mark(state: AgentState, meta?: EventMeta): number[] {
  return meta?.seq === undefined ? state.seen : [...state.seen, meta.seq];
}

/** A verb the user would recognise, from the grant's effect name. */
function verb(effect: string): string {
  return effect.replace(/_/g, ' ');
}

// ── stage rail ─────────────────────────────────────────────────────────────

export const STAGES: StageName[] = ['see', 'seal', 'send', 'gate', 'log'];

const STAGE_OF: Record<AgentPhase, number> = {
  IDLE: -1,
  CAPTURING: 0,
  DETECTING: 0,
  REDACTING: 1,
  BUILDING_SCENE: 2,
  PLANNING: 2,
  AWAITING_CONFIRMATION: 3,
  EXECUTING: 3,
  COMPLETE: 4,
  REFUSED: 3,
  ERROR: -1,
};

/**
 * Driven by the phase the worker reports, never by a timer. A rail that
 * advances on its own would keep moving after the pipeline had stopped.
 */
export function stageStates(phase: AgentPhase): StageState[] {
  const at = STAGE_OF[phase];
  return STAGES.map((_, i) => {
    if (at < 0) return 'idle';
    if (phase === 'COMPLETE') return 'done';
    if (i < at) return 'done';
    if (i === at) return 'active';
    return 'idle';
  });
}

// ── reducer ────────────────────────────────────────────────────────────────

export function reducer(state: AgentState, e: AgentEvent): AgentState {
  switch (e.type) {
    case 'PAGE': return { ...state, page: e.page };

    case 'TASK_STARTED':
      return { ...initialState, page: state.page, task: e.task, phase: 'CAPTURING' };

    // Any phase other than the wait itself means the question is settled;
    // drop the pending request so the dialog cannot be clicked twice.
    case 'PHASE': return {
      ...state, phase: e.phase,
      pending: e.phase === 'AWAITING_CONFIRMATION' ? state.pending : null,
    };

    case 'OBSERVED': {
      if (alreadySeen(state, e.meta)) return state;
      const feed = append(state, [{
        kind: 'send',
        icon: 'eye',
        title: 'Page observed',
        detail: `${e.elements} interactive ${e.elements === 1 ? 'field' : 'fields'} described`,
      }], e.meta);
      return {
        ...state,
        feed,
        observed: { elements: e.elements, sensitive: e.sensitive },
        seen: mark(state, e.meta),
      };
    }

    case 'DETECTION': return { ...state, detection: e.detection };

    case 'REDACTION': {
      if (alreadySeen(state, e.meta)) {
        return { ...state, redaction: e.redaction, fields: e.fields };
      }
      const sealed = e.fields.filter((f) => f.sensitive);
      const rows: Omit<FeedItem, 'id' | 'at' | 'replay'>[] = sealed.map((f) => ({
        kind: 'seal' as const,
        icon: 'seal' as const,
        title: `Sealed ${f.label}`,
        detail: 'Value replaced locally; only the reference is sent.',
        code: f.ref,
      }));

      // The fields we deliberately did not mask. This is the answer to
      // over-redaction, and it belongs in the stream rather than a slide.
      // Counts come from the observation pass, not from `fields`, which the
      // redactor caps for display.
      const obs = state.observed;
      if (obs) {
        const visible = Math.max(obs.elements - obs.sensitive, 0);
        rows.push({
          kind: 'send',
          icon: 'check',
          title: `${visible} ${visible === 1 ? 'field' : 'fields'} left visible`,
          detail: 'Not sensitive, so not masked. The planner sees these in full.',
        });
      }

      return {
        ...state,
        redaction: e.redaction,
        fields: e.fields,
        feed: append(state, rows, e.meta),
        seen: mark(state, e.meta),
      };
    }

    case 'OUTBOUND': {
      if (alreadySeen(state, e.meta)) return { ...state, outbound: e.outbound };
      const s = e.outbound;
      const rows: Omit<FeedItem, 'id' | 'at' | 'replay'>[] = s ? [{
        kind: 'send',
        icon: 'up',
        title: 'Payload asserted and sent',
        detail: `${s.fieldsDescribed} fields described · ${s.piiValuesSent} values · ${s.rawPixelsSent} raw pixels`,
      }] : [];
      return {
        ...state, outbound: e.outbound,
        feed: append(state, rows, e.meta),
        seen: mark(state, e.meta),
      };
    }

    case 'CONFIRM_REQUIRED':
      return { ...state, phase: 'AWAITING_CONFIRMATION', pending: e.pending };

    case 'ACTION_RESOLVED': {
      const audit = [e.entry, ...state.audit];
      if (alreadySeen(state, e.meta)) return { ...state, pending: null, audit };
      const refusedNow = e.entry.outcome === 'refused';

      // The headline mechanism, reported at the moment it happens.
      const isSecret = e.entry.effect === 'set_secret';
      const row: Omit<FeedItem, 'id' | 'at' | 'replay'> = refusedNow
        ? {
            kind: 'refuse', icon: 'stop',
            title: `${verb(e.entry.effect)} REFUSED`,
            // Verbatim from the gate. Its precision is the argument; softening
            // it into friendlier copy would throw that away.
            detail: e.entry.reason,
          }
        : {
            kind: 'exec', icon: 'check',
            title: isSecret ? 'Credential resolved at the moment of use' : `${verb(e.entry.effect)} executed`,
            detail: isSecret
              ? 'The planner named two references and never held a value.'
              : undefined,
          };

      return {
        ...state,
        pending: null,
        audit,
        refused: state.refused + (refusedNow ? 1 : 0),
        feed: append(state, [row], e.meta),
        seen: mark(state, e.meta),
      };
    }

    case 'MANIFEST': {
      if (alreadySeen(state, e.meta) || e.entries.length === 0) return state;
      return {
        ...state,
        feed: append(state, [{
          kind: 'send', icon: 'log',
          title: 'Written to egress manifest',
          detail: `${e.entries.length} ${e.entries.length === 1 ? 'entry' : 'entries'} recorded this run`,
        }], e.meta),
        seen: mark(state, e.meta),
      };
    }

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
