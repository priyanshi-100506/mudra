import { describe, it, expect } from 'vitest';
import { checkAction, effectOf, effectOfControl, deriveGrant, isHighImpact }
  from '../../extension/src/shared/grant';
import type { AgentAction } from '../../extension/src/shared/types';

const click = (id: string): AgentAction => ({ action: 'click', element_id: id } as AgentAction);

/** The grant a presenter's task produces: fill a KYC form on this origin. */
function kycGrant(authorised = true) {
  const g = deriveGrant('Fill this KYC form with my details and submit it', 'https://portal.test');
  return { ...g, authorised };
}

describe('a click is read from what it lands on', () => {
  it('is an ordinary click on an ordinary control', () => {
    expect(effectOf(click('e1'), 'Next')).toBe('click');
    expect(effectOf(click('e1'), 'Show more')).toBe('click');
    expect(effectOf(click('e1'), null)).toBe('click');
  });

  it('is a transfer when the button says so', () => {
    expect(effectOf(click('e9'), 'Transfer ₹50,000')).toBe('transfer');
    expect(effectOfControl('Send money')).toBe('transfer');
    expect(effectOfControl('Pay now')).toBe('transfer');
  });

  it('recognises purchase, delete and upload controls too', () => {
    expect(effectOfControl('Place order')).toBe('purchase');
    expect(effectOfControl('Close account')).toBe('delete');
    expect(effectOfControl('Upload document')).toBe('upload');
  });

  it('does not fire on ordinary words that merely contain them', () => {
    // Over-firing costs the agent controls it legitimately needs.
    expect(effectOfControl('Transfers history')).toBeNull();
    expect(effectOfControl('Payment methods')).toBeNull();
    expect(effectOfControl('Deleted items')).toBeNull();
  });

  it('treats all four as high-impact', () => {
    for (const e of ['transfer', 'purchase', 'delete', 'upload']) {
      expect(isHighImpact(e)).toBe(true);
    }
  });
});

describe('the injected transfer is refused', () => {
  const origin = 'https://portal.test';

  it('refuses a click on the transfer button under a KYC grant', () => {
    // This is the demo. The injected instruction asks for an action the
    // task never covered, and the gate says so.
    const verdict = checkAction(click('e9'), kycGrant(), origin, 'Transfer ₹50,000');
    expect(verdict.kind).toBe('refuse');
    if (verdict.kind === 'refuse') {
      expect(verdict.effect).toBe('transfer');
      expect(verdict.reason).toMatch(/not among the effects authorised/);
    }
  });

  it('would have ALLOWED it if the effect were read from the verb alone', () => {
    // The regression this guards. A prompt injection does not ask for a new
    // permission — it asks for one the task already has. Without the target
    // label, "click the Transfer button" is just a click, and every grant
    // allows clicks.
    const asPlainClick = checkAction(click('e9'), kycGrant(), origin);
    expect(asPlainClick.kind).toBe('allow');
  });

  it('still allows the ordinary clicks the task needs', () => {
    expect(checkAction(click('e1'), kycGrant(), origin, 'Next').kind).toBe('allow');
  });

  it('still allows the submit the task was authorised for', () => {
    const verdict = checkAction(
      { action: 'submit', element_id: 'e10' } as AgentAction,
      kycGrant(), origin, 'Submit KYC application',
    );
    expect(verdict.kind).toBe('allow');
  });

  it('refuses the transfer even on a login grant, which allows more', () => {
    const login = { ...deriveGrant('log in to my account', origin), authorised: true };
    expect(checkAction(click('e9'), login, origin, 'Transfer ₹50,000').kind).toBe('refuse');
  });

  it('refuses when the page navigated away from the granted origin', () => {
    const verdict = checkAction(click('e1'), kycGrant(), 'https://attacker.test', 'Next');
    expect(verdict.kind).toBe('refuse');
    if (verdict.kind === 'refuse') expect(verdict.reason).toMatch(/issued for/);
  });

  it('refuses a transfer on an unauthorised grant rather than prompting', () => {
    const verdict = checkAction(click('e9'), kycGrant(false), origin, 'Transfer ₹50,000');
    expect(verdict.kind).toBe('refuse');
  });
});
