import { describe, it, expect } from 'vitest';
import { reducer, initialState, stageStates, STAGES, FEED_CAP } from '../../extension/sidepanel/state';
import type { AgentEvent } from '../../extension/sidepanel/state';
import type { AgentState } from '../../extension/sidepanel/types';

const field = (ref: string, label: string, sensitive: boolean) =>
  ({ ref, label, role: 'textbox', sensitive, elementId: ref });

const run = (events: AgentEvent[], from: AgentState = initialState) =>
  events.reduce(reducer, from);

const AT = '2026-09-13T10:00:00.000Z';

/** A whole pass: observe, seal, send. */
const pass = (seqFrom: number, replay = false): AgentEvent[] => [
  { type: 'OBSERVED', elements: 12, sensitive: 2, meta: { seq: seqFrom, at: AT, replay } },
  {
    type: 'REDACTION',
    redaction: { textReferences: 2, maskedRegions: 0, reOcrVerified: false },
    fields: [field('ref_a1', 'Password', true), field('ref_b2', 'PAN', true), field('e3', 'Branch', false)],
    meta: { seq: seqFrom + 1, at: AT, replay },
  },
  {
    type: 'OUTBOUND',
    outbound: { rawPixelsSent: 0, piiValuesSent: 0, fieldsDescribed: 12, preview: '[]' },
    meta: { seq: seqFrom + 2, at: AT, replay },
  },
];

describe('the feed is built from emitted events', () => {
  it('reports the observation, each seal, and what was left visible', () => {
    const s = run(pass(1));
    const titles = s.feed.map((f) => f.title);
    expect(titles).toEqual([
      'Page observed',
      'Sealed Password',
      'Sealed PAN',
      '10 fields left visible',
      'Payload asserted and sent',
    ]);
  });

  it('carries the ref as a code chip on each seal', () => {
    const s = run(pass(1));
    expect(s.feed.filter((f) => f.kind === 'seal').map((f) => f.code)).toEqual(['ref_a1', 'ref_b2']);
  });

  it('counts fields left visible from the observation, not the capped field list', () => {
    // `fields` is capped for display; 12 observed - 2 sealed is the truth.
    const s = run(pass(1));
    expect(s.feed.find((f) => f.title.includes('left visible'))?.title).toBe('10 fields left visible');
  });

  it('stamps rows with the emitter time, not the render time', () => {
    expect(run(pass(1)).feed.every((f) => f.at === AT)).toBe(true);
  });
});

describe('refusals', () => {
  const refusal: AgentEvent = {
    type: 'ACTION_RESOLVED',
    entry: {
      at: AT, effect: 'navigate_cross_origin', outcome: 'refused',
      reason: '"navigate_cross_origin" is not among the effects authorised for this task.',
    },
    meta: { seq: 10, at: AT },
  };

  it('renders the gate reason verbatim', () => {
    const s = run([refusal]);
    const row = s.feed.at(-1)!;
    expect(row.kind).toBe('refuse');
    expect(row.detail).toBe('"navigate_cross_origin" is not among the effects authorised for this task.');
  });

  it('increments the refused counter', () => {
    expect(run([refusal]).refused).toBe(1);
  });

  it('leaves the counter at zero when nothing was refused', () => {
    expect(run(pass(1)).refused).toBe(0);
  });
});

describe('the credential moment is reported explicitly', () => {
  it('names the mechanism rather than the verb', () => {
    const s = run([{
      type: 'ACTION_RESOLVED',
      entry: { at: AT, effect: 'set_secret', outcome: 'executed' },
      meta: { seq: 20, at: AT },
    }]);
    const row = s.feed.at(-1)!;
    expect(row.title).toBe('Credential resolved at the moment of use');
    expect(row.detail).toMatch(/never held a value/);
  });
});

describe('replay renders without duplicating or re-animating', () => {
  it('does not double-count when the same events arrive again', () => {
    const live = run(pass(1));
    const replayed = run(pass(1, true), live);
    expect(replayed.feed).toHaveLength(live.feed.length);
    expect(replayed.observed).toEqual(live.observed);
  });

  it('does not double-count refusals on replay', () => {
    const e: AgentEvent = {
      type: 'ACTION_RESOLVED',
      entry: { at: AT, effect: 'submit_form', outcome: 'refused', reason: 'nope' },
      meta: { seq: 31, at: AT },
    };
    const live = run([e]);
    const again = run([{ ...e, meta: { seq: 31, at: AT, replay: true } }], live);
    expect(again.refused).toBe(1);
  });

  it('marks replayed rows so they are not animated', () => {
    const s = run(pass(1, true));
    expect(s.feed.every((f) => f.replay)).toBe(true);
  });

  it('animates genuinely new rows', () => {
    const s = run(pass(1));
    expect(s.feed.every((f) => f.replay)).toBe(false);
  });
});

describe('the feed is bounded', () => {
  it(`keeps at most ${FEED_CAP} rows, dropping oldest`, () => {
    let s: AgentState = initialState;
    for (let i = 0; i < FEED_CAP + 40; i++) {
      s = reducer(s, {
        type: 'ACTION_RESOLVED',
        entry: { at: AT, effect: `click_${i}`, outcome: 'executed' },
        meta: { seq: 1000 + i, at: AT },
      });
    }
    expect(s.feed).toHaveLength(FEED_CAP);
    expect(s.feed.at(-1)!.title).toContain(`click ${FEED_CAP + 39}`);
  });
});

describe('the stage rail follows the worker, never a timer', () => {
  it('is idle before a run', () => {
    expect(stageStates('IDLE')).toEqual(['idle', 'idle', 'idle', 'idle', 'idle']);
  });

  it('marks earlier stages done and the current one active', () => {
    expect(stageStates('REDACTING')).toEqual(['done', 'active', 'idle', 'idle', 'idle']);
    expect(stageStates('PLANNING')).toEqual(['done', 'done', 'active', 'idle', 'idle']);
  });

  it('puts the gate stage active while awaiting the user', () => {
    expect(stageStates('AWAITING_CONFIRMATION')[3]).toBe('active');
  });

  it('completes every stage at the end', () => {
    expect(stageStates('COMPLETE')).toEqual(STAGES.map(() => 'done'));
  });

  it('shows a refusal at the gate, not past it', () => {
    const s = stageStates('REFUSED');
    expect(s[3]).toBe('active');
    expect(s[4]).toBe('idle');
  });
});
