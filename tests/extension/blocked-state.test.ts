import { describe, it, expect } from 'vitest';
import { reducer, initialState, isTerminal, PHASE_LABEL } from '../../extension/sidepanel/state';
import { toAgentEvent } from '../../extension/sidepanel/bridge';
import { generateCanaries, canaryReport, scanForCanaries, CanaryEscape, assertNoCanaries }
  from '../../extension/src/shared/canary';

const escapeEvent = {
  type: 'AGENT_BLOCKED' as const,
  title: 'Blocked: redactor fault, canary escaped',
  detail: 'Canary escaped (aadhaar): a tracer value reached the serialised request body.',
  planted: 3,
  escaped: 1,
  escapedKinds: ['aadhaar'],
};

describe('a canary escape becomes a state a person can see', () => {
  it('is not silently swallowed into a generic error', () => {
    const event = toAgentEvent(escapeEvent);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('BLOCKED');
  });

  it('lands in a named phase with its own label', () => {
    const s = reducer(initialState, toAgentEvent(escapeEvent)!);
    expect(s.phase).toBe('BLOCKED');
    expect(PHASE_LABEL.BLOCKED).toMatch(/canary/i);
    expect(s.blocked).toMatchObject({ planted: 3, escaped: 1, escapedKinds: ['aadhaar'] });
  });

  it('stays stopped — no retry, no degraded continue', () => {
    expect(isTerminal('BLOCKED')).toBe(true);
  });

  it('clears any pending confirmation so nothing can still be approved', () => {
    const withPending = reducer(initialState, {
      type: 'CONFIRM_REQUIRED',
      pending: { sentence: 'Type into the password box', origin: 'bank.test', effect: 'type', targetRole: 'textbox', targetRef: 'ref_x' },
    } as never);
    expect(withPending.pending).not.toBeNull();
    const blocked = reducer(withPending, toAgentEvent(escapeEvent)!);
    expect(blocked.pending).toBeNull();
  });

  it('names the kinds that escaped but never the values', () => {
    const canaries = generateCanaries();
    let thrown: CanaryEscape | null = null;
    try {
      assertNoCanaries(JSON.stringify({ leak: canaries[0].value }));
    } catch (e) { thrown = e as CanaryEscape; }

    const s = reducer(initialState, toAgentEvent({
      type: 'AGENT_BLOCKED',
      title: 'Blocked: redactor fault, canary escaped',
      detail: thrown!.message,
      ...thrown!.report,
    })!);

    const rendered = JSON.stringify(s.blocked);
    expect(rendered).toContain('aadhaar');
    // Reporting a leaked tracer by printing it would leak it again.
    for (const c of canaries) expect(rendered).not.toContain(c.value);
  });

  it('reports the clean case as 3 planted, 0 escaped', () => {
    generateCanaries();
    expect(canaryReport([])).toEqual({ planted: 3, escaped: 0, escapedKinds: [] });
    expect(scanForCanaries('{"elements":[]}')).toEqual([]);
  });
});
