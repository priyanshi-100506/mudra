import type { AgentAction, FormContext } from './types';

/** A local, task- and document-scoped authorisation. Never minted by the server. */
export interface Grant {
  task: string;
  origin: string;
  allowedEffects: string[];
  maxUses: number;
  usesRemaining: number;
  /**
   * Set once, by the user, before the page is ever observed. Until it is true
   * nothing high-impact runs — an unauthorised grant refuses rather than
   * prompting, so a task that skipped the dialog cannot quietly proceed.
   */
  authorised: boolean;
}

/** Effects that require the user to confirm before they run. */
const HIGH_IMPACT = new Set([
  'submit_form', 'navigate_cross_origin', 'transfer', 'purchase',
  'delete', 'upload', 'set_secret', 'submit_cross_origin',
]);

/**
 * Controls whose label says they move money or destroy something.
 *
 * A click is not inherently high-impact, which is why `click` sits in every
 * grant's base effects — an agent that needs confirmation to click a tab is
 * useless. But a click on a button reading "Transfer Rs 50,000" is a
 * transfer, and calling it `click` is how a prompt-injection walks straight
 * through the gate: the injected instruction does not ask for a new
 * permission, it asks for one the task already has.
 *
 * So the effect is read from what the click lands on, not from the verb
 * alone. The label is page content and therefore attacker-controlled, but
 * only in the direction of *more* restriction: a page can talk MUDRA into
 * asking for confirmation it did not need, never out of asking for one it
 * did.
 */
const CONTROL_EFFECT: Array<[RegExp, string]> = [
  [/\b(transfer|remit|send\s*money|pay\s*now|make\s*payment|wire)\b/i, 'transfer'],
  [/\b(buy|purchase|place\s*order|checkout|subscribe)\b/i, 'purchase'],
  [/\b(delete|remove|close\s*account|deactivate|erase)\b/i, 'delete'],
  [/\b(upload|attach\s*document)\b/i, 'upload'],
];

/**
 * Field names that make a form a payment form.
 *
 * The second layer, and the one that does not trust the page. A label is
 * page content and the page chooses it, so a button reading "Continue" that
 * submits an amount and a payee is still a payment — the label check alone
 * defeats only honest labels. The *shape* of a form is much harder to
 * disguise, because changing it means changing what the form actually does.
 */
const FORM_FIELD_EFFECT: Array<[RegExp, string]> = [
  [/\b(amount|amt|payee|beneficiary|account[_\s-]?(no|number)|upi|vpa|ifsc|remit|transfer|payment)\b/i, 'transfer'],
  [/\b(card[_\s-]?(no|number)|cvv|cvc|expiry|checkout|order[_\s-]?total|quantity)\b/i, 'purchase'],
  [/\b(confirm[_\s-]?delete|delete[_\s-]?account|deactivate|close[_\s-]?account)\b/i, 'delete'],
];

/** Path fragments that say what an endpoint does, when the fields do not. */
const FORM_ACTION_EFFECT: Array<[RegExp, string]> = [
  [/\/(transfer|payment|pay|remit|neft|imps|rtgs|fund)/i, 'transfer'],
  [/\/(checkout|purchase|order|buy|subscribe)/i, 'purchase'],
  [/\/(delete|close|deactivate|terminate)/i, 'delete'],
];

/**
 * What the form an element sits in would actually do.
 *
 * Returns null for an ordinary form. Note that this can only ever *raise*
 * the required permission, never lower it: the worst a hostile page can do
 * by manipulating its own form is make MUDRA ask for a confirmation it did
 * not strictly need.
 */
export function effectOfForm(form: FormContext | null | undefined): string | null {
  if (!form) return null;
  const fields = form.fieldNames.join(' ');
  for (const [pattern, effect] of FORM_FIELD_EFFECT) {
    if (pattern.test(fields)) return effect;
  }
  for (const [pattern, effect] of FORM_ACTION_EFFECT) {
    if (pattern.test(form.action)) return effect;
  }
  // A POST to another origin is not classifiable, but it is consequential
  // and irreversible, which is enough to require a human.
  if (form.crossOrigin && form.method === 'post') return 'submit_cross_origin';
  return null;
}

/** What a control's label says it does, or null if it says nothing alarming. */
export function effectOfControl(label: string | null | undefined): string | null {
  const text = label ?? '';
  for (const [pattern, effect] of CONTROL_EFFECT) {
    if (pattern.test(text)) return effect;
  }
  return null;
}

/**
 * Maps a planner action onto the effect name a grant talks about.
 *
 * `targetLabel` is the name of the element the action points at, when the
 * caller knows it. Without it a click is just a click, so callers that can
 * resolve the target should pass it — that is the difference between
 * refusing an injected transfer and executing one.
 */
export function effectOf(
  action: AgentAction,
  targetLabel?: string | null,
  form?: FormContext | null,
): string {
  switch (action.action) {
    // Two independent readings, and the stricter one wins. The label is
    // checked first only because it is more specific when it is honest;
    // the form shape catches the case where it is not.
    case 'click':    return effectOfControl(targetLabel) ?? effectOfForm(form) ?? 'click';
    case 'type':     return 'set_public_text';
    case 'select':   return 'select';
    case 'scroll':   return 'scroll';
    case 'extract':  return 'extract';
    case 'wait':     return 'wait';
    case 'submit':   return effectOfForm(form) ?? 'submit_form';
    case 'navigate': return 'navigate_cross_origin';
    case 'done':     return 'done';
    default:         return 'unknown';
  }
}

export const isHighImpact = (effect: string) => HIGH_IMPACT.has(effect);

/** Derived locally at task start from a small set of templates. */
export function deriveGrant(task: string, origin: string): Grant {
  const t = task.toLowerCase();
  const base = ['click', 'set_public_text', 'select', 'scroll', 'wait', 'extract', 'done'];

  if (t.includes('log') || t.includes('sign in')) {
    return { task: 'login', origin, allowedEffects: [...base, 'set_secret', 'submit_form'],
             maxUses: 1, usesRemaining: 1, authorised: false };
  }
  if (t.includes('fill') || t.includes('form') || t.includes('apply')) {
    return { task: 'form_fill', origin, allowedEffects: [...base, 'submit_form'],
             maxUses: 1, usesRemaining: 1, authorised: false };
  }
  return { task: 'read_only', origin, allowedEffects: base, maxUses: 0, usesRemaining: 0,
           authorised: false };
}

export type Verdict =
  | { kind: 'allow'; effect: string; consumesUse: boolean }
  /**
   * Consequential, and the grant does not settle it either way.
   *
   * The case this exists for: a click whose effect we could only derive from
   * the page — a payment-shaped form behind a button labelled "Continue" —
   * or a submit on a form the task never mentioned. Silently allowing it
   * trusts a page that has already shown it will lie about its own labels.
   * Refusing outright would make the agent useless on any form we cannot
   * classify. So a person decides.
   */
  | { kind: 'confirm'; effect: string; reason: string; consumesUse: boolean }
  | { kind: 'refuse'; effect: string; reason: string };

/**
 * The gate. Every side-effecting action passes through here before execution.
 * Fail closed: anything unmatched is refused.
 */
export function checkAction(
  action: AgentAction,
  grant: Grant | null,
  currentOrigin: string,
  /** Label of the element the action targets, when the caller can resolve it. */
  targetLabel?: string | null,
  /** The form the target sits in, when there is one. */
  form?: FormContext | null,
): Verdict {
  const effect = effectOf(action, targetLabel, form);

  // The two readings are kept apart, because they warrant different answers.
  //
  // A control that *says* it transfers money, under a task that does not
  // cover transfers, is a planner asking for something plainly outside its
  // remit — refuse it, and say so. But an ordinary-looking button over a
  // payment-shaped form is ambiguous: it may genuinely be the payment the
  // user is trying to make, and the only thing that can settle it is the
  // user. Refusing every unclassifiable form would make the agent useless
  // on real sites; allowing them silently would trust a page that has
  // already shown it chooses its own labels.
  const labelEffect = action.action === 'click' ? effectOfControl(targetLabel) : null;
  const formEffect = effectOfForm(form);

  if (!grant) {
    return { kind: 'refuse', effect, reason: 'No grant is active for this task.' };
  }
  if (grant.origin !== currentOrigin) {
    return { kind: 'refuse', effect,
             reason: `Grant was issued for ${grant.origin}, page is now ${currentOrigin}.` };
  }
  if (!grant.allowedEffects.includes(effect)) {
    // Derived from the page's own form rather than from what the control
    // claims: ambiguous, so a person decides.
    if (!labelEffect && formEffect === effect) {
      return {
        kind: 'confirm',
        effect,
        reason:
          `This looks like a ${effect.replace(/_/g, ' ')}: the form it belongs to ` +
          `submits ${describeForm(form)}. Your task did not authorise that.`,
        consumesUse: true,
      };
    }
    return { kind: 'refuse', effect,
             reason: `"${effect}" is not among the effects authorised for this task.` };
  }
  if (isHighImpact(effect)) {
    // The user authorised this task, on this origin, before anything was
    // observed — and saw which effects that covered. What is checked here is
    // that the authorisation exists and has not been spent.
    if (!grant.authorised) {
      return { kind: 'refuse', effect, reason: 'This task has not been authorised.' };
    }
    if (grant.usesRemaining <= 0) {
      return { kind: 'refuse', effect, reason: 'This authorisation has already been used.' };
    }
    return { kind: 'allow', effect, consumesUse: true };
  }

  // Past here the effect is ordinary — a click, a scroll. But an ordinary
  // verb on a consequential form is the gap the label check leaves open, and
  // the page controls the label.
  if (formEffect && !grant.allowedEffects.includes(formEffect)) {
    return {
      kind: 'confirm',
      effect: formEffect,
      reason:
        `This looks like a ${formEffect.replace(/_/g, ' ')}: the form it belongs to ` +
        `submits ${describeForm(form)}. Your task did not authorise that.`,
      consumesUse: true,
    };
  }

  return { kind: 'allow', effect, consumesUse: false };
}

/** A short, non-sensitive description of what a form would send. */
function describeForm(form: FormContext | null | undefined): string {
  if (!form) return 'an unknown form';
  const notable = form.fieldNames
    .filter((n) => /amount|payee|beneficiary|account|upi|vpa|ifsc|card|cvv/i.test(n))
    .slice(0, 3);
  const where = form.crossOrigin ? ' to another site' : '';
  return notable.length
    ? `${notable.join(', ')}${where}`
    : `${form.fieldNames.length} fields${where}`;
}

/** The one question the user is asked, before the page is read. */
export function taskSentence(grant: Grant): string {
  const host = grant.origin.replace(/^https?:\/\//, '') || 'this page';
  switch (grant.task) {
    case 'login':     return `Let Mudra sign you in on ${host}?`;
    case 'form_fill': return `Let Mudra fill and submit this form on ${host}?`;
    default:          return `Let Mudra read ${host} to do this?`;
  }
}

/** Plain-language summary of what the grant permits, for the dialog. */
export function grantSummary(grant: Grant): string[] {
  const lines = ['Read the visible fields on this page'];
  if (grant.allowedEffects.includes('set_public_text')) lines.push('Type into ordinary fields');
  if (grant.allowedEffects.includes('set_secret')) lines.push('Enter a saved credential by reference');
  if (grant.allowedEffects.includes('submit_form')) {
    lines.push(grant.maxUses === 1 ? 'Submit the form once' : 'Submit the form');
  }
  lines.push('Sensitive values stay on this device');
  return lines;
}

/** One plain sentence a non-technical reader parses in three seconds. */
export function confirmSentence(effect: string, origin: string): string {
  const host = origin.replace(/^https?:\/\//, '');
  switch (effect) {
    case 'submit_form':            return `Submit this form on ${host}?`;
    case 'set_secret':             return `Enter your saved credential on ${host}?`;
    case 'navigate_cross_origin':  return `Leave ${host} and open another site?`;
    case 'upload':                 return `Upload a file to ${host}?`;
    default:                       return `Allow "${effect}" on ${host}?`;
  }
}
