import { describe, it, expect } from 'vitest';
import {
  deriveGrant, checkAction, effectOf, isHighImpact, taskSentence, grantSummary,
} from '../../extension/src/shared/grant';
import type { AgentAction } from '../../extension/src/shared/types';

const ORIGIN = 'https://bank.example.in';

/** A grant as it exists after the user has answered the one dialog. */
const authorised = (goal = 'log in to my account') => {
  const g = deriveGrant(goal, ORIGIN);
  g.authorised = true;
  return g;
};

const submit: AgentAction = { action: 'submit', element_id: 'e1' };
const type: AgentAction = { action: 'type', element_id: 'e1', text: 'hello' };
const exfil: AgentAction = { action: 'navigate', url: 'https://collector.example.net/exfil' };

describe('a task is authorised once, up front', () => {
  it('starts unauthorised — the dialog has not been answered yet', () => {
    expect(deriveGrant('log in', ORIGIN).authorised).toBe(false);
  });

  it('refuses a high-impact action until the task is authorised', () => {
    const v = checkAction(submit, deriveGrant('log in', ORIGIN), ORIGIN);
    expect(v.kind).toBe('refuse');
    expect(v.kind === 'refuse' && v.reason).toMatch(/not been authorised/i);
  });

  it('allows the submit once the task is authorised, without asking again', () => {
    const v = checkAction(submit, authorised(), ORIGIN);
    expect(v.kind).toBe('allow');
    expect(v.kind === 'allow' && v.consumesUse).toBe(true);
  });

  it('spends the single use, so a second submit is refused', () => {
    const g = authorised();
    const first = checkAction(submit, g, ORIGIN);
    expect(first.kind).toBe('allow');
    g.usesRemaining -= 1;                       // what the worker does on execute
    const second = checkAction(submit, g, ORIGIN);
    expect(second.kind).toBe('refuse');
    expect(second.kind === 'refuse' && second.reason).toMatch(/already been used/i);
  });

  it('never asks for ordinary typing, and does not spend the use on it', () => {
    const v = checkAction(type, authorised(), ORIGIN);
    expect(v.kind).toBe('allow');
    expect(v.kind === 'allow' && v.consumesUse).toBe(false);
  });
});

describe('authorising the task does not authorise anything else', () => {
  it('still refuses an injected cross-origin navigation', () => {
    // The whole point of the up-front grant: it covers the task, not whatever
    // a compromised planner proposes next.
    const v = checkAction(exfil, authorised(), ORIGIN);
    expect(v.kind).toBe('refuse');
  });

  it('still refuses once the page has moved to another origin', () => {
    const v = checkAction(type, authorised(), 'https://evil.example.net');
    expect(v.kind).toBe('refuse');
    expect(v.kind === 'refuse' && v.reason).toMatch(/issued for/i);
  });

  it('refuses a submit on a read-only task even when authorised', () => {
    const g = authorised('read the page and tell me the balance');
    expect(g.task).toBe('read_only');
    const v = checkAction(submit, g, ORIGIN);
    expect(v.kind).toBe('refuse');
    expect(v.kind === 'refuse' && v.reason).toMatch(/not among the effects/i);
  });

  it('refuses with no grant at all', () => {
    expect(checkAction(type, null, ORIGIN).kind).toBe('refuse');
  });

  it('fails closed on an unknown action', () => {
    const v = checkAction({ action: 'wire_funds' } as unknown as AgentAction,
                          authorised(), ORIGIN);
    expect(v.kind).toBe('refuse');
    expect(effectOf({ action: 'wire_funds' } as unknown as AgentAction)).toBe('unknown');
  });
});

describe('the dialog tells the user what they are agreeing to', () => {
  it('names the site in the question', () => {
    expect(taskSentence(authorised())).toContain('bank.example.in');
  });

  it('discloses the submit when the task can submit', () => {
    const lines = grantSummary(authorised('fill in this form')).join(' ');
    expect(lines).toMatch(/submit/i);
  });

  it('does not promise a submit on a read-only task', () => {
    const lines = grantSummary(authorised('read the page')).join(' ');
    expect(lines).not.toMatch(/submit/i);
  });

  it('says sensitive values stay local', () => {
    expect(grantSummary(authorised()).join(' ')).toMatch(/stay on this device/i);
  });

  it('agrees with the high-impact set it is describing', () => {
    expect(isHighImpact('submit_form')).toBe(true);
    expect(isHighImpact('navigate_cross_origin')).toBe(true);
    expect(isHighImpact('set_public_text')).toBe(false);
  });
});
