import { describe, it, expect } from 'vitest';
import { checkAction, effectOf, effectOfForm, deriveGrant }
  from '../../extension/src/shared/grant';
import { capturePageIR } from '../../extension/src/content/perception';
import type { AgentAction, FormContext } from '../../extension/src/shared/types';

const click = (id: string): AgentAction => ({ action: 'click', element_id: id } as AgentAction);
const submit = (id: string): AgentAction => ({ action: 'submit', element_id: id } as AgentAction);

const form = (over: Partial<FormContext> = {}): FormContext => ({
  action: 'https://portal.test/next',
  method: 'post',
  crossOrigin: false,
  fieldNames: ['full_name', 'city'],
  ...over,
});

function kycGrant(authorised = true) {
  const g = deriveGrant('Fill this KYC form with my details and submit it', 'https://portal.test');
  return { ...g, authorised };
}

describe('the form is read, not the button', () => {
  it('sees a payment in a form that submits an amount and a payee', () => {
    expect(effectOfForm(form({ fieldNames: ['amount', 'payee', 'remarks'] }))).toBe('transfer');
  });

  it('sees a payment from account and IFSC fields', () => {
    expect(effectOfForm(form({ fieldNames: ['beneficiary_account_no', 'ifsc'] }))).toBe('transfer');
  });

  it('sees a purchase from card fields', () => {
    expect(effectOfForm(form({ fieldNames: ['card_number', 'cvv', 'expiry'] }))).toBe('purchase');
  });

  it('falls back to the endpoint when the field names say nothing', () => {
    expect(effectOfForm(form({ action: 'https://bank.test/api/transfer', fieldNames: ['a', 'b'] })))
      .toBe('transfer');
  });

  it('treats a cross-origin POST as consequential even when unclassifiable', () => {
    expect(effectOfForm(form({ crossOrigin: true, method: 'post', fieldNames: ['x'] })))
      .toBe('submit_cross_origin');
  });

  it('leaves an ordinary form alone', () => {
    expect(effectOfForm(form())).toBeNull();
    expect(effectOfForm(null)).toBeNull();
  });

  it('does not treat a cross-origin GET as consequential', () => {
    // A search box posting to another origin is not a payment.
    expect(effectOfForm(form({ crossOrigin: true, method: 'get' }))).toBeNull();
  });
});

describe('a transfer button labelled "Continue"', () => {
  const origin = 'https://portal.test';
  const paymentForm = form({
    action: 'https://portal.test/funds/transfer',
    fieldNames: ['amount', 'payee_account', 'ifsc'],
  });

  it('is not disguised by its label', () => {
    // The label check alone defeats only honest labels. The page chooses
    // its own button text; it cannot as easily change what the form does.
    expect(effectOf(click('e9'), 'Continue', paymentForm)).toBe('transfer');
  });

  it('is NOT silently allowed under a KYC grant', () => {
    const verdict = checkAction(click('e9'), kycGrant(), origin, 'Continue', paymentForm);
    expect(verdict.kind).not.toBe('allow');
  });

  it('asks the user rather than deciding for them', () => {
    const verdict = checkAction(click('e9'), kycGrant(), origin, 'Continue', paymentForm);
    expect(verdict.kind).toBe('confirm');
    if (verdict.kind === 'confirm') {
      expect(verdict.effect).toBe('transfer');
      // The question has to say what the form would actually send.
      expect(verdict.reason).toMatch(/amount|payee/);
      expect(verdict.reason).toMatch(/did not authorise/);
    }
  });

  it('would have been allowed with the label check alone', () => {
    // The regression this layer exists for.
    expect(checkAction(click('e9'), kycGrant(), origin, 'Continue').kind).toBe('allow');
  });

  it('still refuses when the label is honest', () => {
    const verdict = checkAction(click('e9'), kycGrant(), origin, 'Transfer ₹50,000', paymentForm);
    expect(verdict.kind).toBe('refuse');
  });

  it('leaves ordinary clicks in ordinary forms alone', () => {
    expect(checkAction(click('e1'), kycGrant(), origin, 'Continue', form()).kind).toBe('allow');
  });
});

describe('submit is read from the form too', () => {
  const origin = 'https://portal.test';

  it('a submit on a payment form is a transfer, not a plain submit', () => {
    const payment = form({ fieldNames: ['amount', 'payee'] });
    expect(effectOf(submit('e9'), 'Submit', payment)).toBe('transfer');
    // Asked, not refused: the task authorised submitting *a* form, and this
    // one may genuinely be the payment the user wants. What it must not be
    // is silent.
    const verdict = checkAction(submit('e9'), kycGrant(), origin, 'Submit', payment);
    expect(verdict.kind).toBe('confirm');
    expect(verdict.kind === 'confirm' && verdict.consumesUse).toBe(true);
  });

  it('a submit on the KYC form itself is still allowed', () => {
    const kyc = form({ fieldNames: ['full_name', 'aadhaar_number', 'pan'] });
    expect(checkAction(submit('e10'), kycGrant(), origin, 'Submit KYC application', kyc).kind)
      .toBe('allow');
  });
});

describe('perception captures the form shape', () => {
  it('records the action, method and field names, but never values', () => {
    document.body.innerHTML = `
      <form action="/funds/transfer" method="post">
        <input name="amount" value="50000">
        <input name="payee_account" value="4520123987654327">
        <button id="go">Continue</button>
      </form>`;
    for (const el of document.body.querySelectorAll<HTMLElement>('input,button')) {
      el.getBoundingClientRect = () => ({
        x: 0, y: 0, width: 200, height: 30, top: 0, left: 0,
        right: 200, bottom: 30, toJSON: () => ({}),
      }) as DOMRect;
    }

    const ir = capturePageIR();
    const button = ir.elements.find((e) => e.role === 'button');
    expect(button?.form).toBeTruthy();
    expect(button!.form!.method).toBe('post');
    expect(button!.form!.fieldNames).toEqual(expect.arrayContaining(['amount', 'payee_account']));
    // Field names, never their values — the point is recognising the shape.
    expect(JSON.stringify(button!.form)).not.toContain('4520123987654327');
    expect(JSON.stringify(button!.form)).not.toContain('50000');
  });

  it('is null for an element outside any form', () => {
    document.body.innerHTML = '<button id="x">Plain</button>';
    const el = document.body.querySelector('button')!;
    el.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 100, height: 30, top: 0, left: 0,
      right: 100, bottom: 30, toJSON: () => ({}),
    }) as DOMRect;
    const ir = capturePageIR();
    expect(ir.elements.find((e) => e.role === 'button')?.form ?? null).toBeNull();
  });
});
