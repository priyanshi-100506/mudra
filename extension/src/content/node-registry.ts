/**
 * Opaque node handle registry.
 *
 * Selectors are unsafe: they are page-controlled, non-unique, and rebindable
 * between the moment we observe the page and the moment we act on it. An
 * attacker-controlled page can swap what #submit points to after the plan is
 * made. This is time-of-check-to-time-of-use (CWE-367).
 *
 * Instead we hand out opaque handles backed by node identity. A handle
 * resolves only inside this document epoch, and the node is revalidated
 * immediately before execution — identity, connectedness, frame origin and
 * expected role must all still match, or the action is refused.
 */

export interface HandleRecord {
  ref: WeakRef<Element>;
  role: string;
  origin: string;
  epoch: string;
}

/** Random per-document identifier. Handles do not survive a new epoch. */
let epoch = crypto.randomUUID();

const registry = new Map<string, HandleRecord>();

export const currentEpoch = () => epoch;

/**
 * Invalidates every outstanding handle. Called on navigation and on
 * significant DOM replacement — a new epoch means the plan was made against
 * a page that no longer exists.
 */
export function rotateEpoch(): string {
  epoch = crypto.randomUUID();
  registry.clear();
  return epoch;
}

/** Listeners that must run when the document changes — e.g. ref rotation. */
const onRotate: Array<() => void> = [];
export function onEpochRotate(fn: () => void): void {
  onRotate.push(fn);
}

export function register(handle: string, el: Element, role: string): void {
  registry.set(handle, {
    ref: new WeakRef(el),
    role,
    origin: window.location.origin,
    epoch,
  });
}

export type ResolveFailure =
  | 'unknown_handle'
  | 'stale_epoch'
  | 'node_collected'
  | 'node_detached'
  | 'origin_changed'
  | 'role_changed'
  | 'not_visible';

export type Resolution =
  | { ok: true; el: Element }
  | { ok: false; reason: ResolveFailure; detail: string };

/**
 * Resolves a handle and revalidates it. Call this immediately before
 * execution — never cache the result. Every check here exists because
 * something can change between plan time and act time.
 */
export function resolve(handle: string, expectedRole?: string): Resolution {
  const rec = registry.get(handle);
  if (!rec) {
    return { ok: false, reason: 'unknown_handle', detail: `No handle "${handle}" in this document.` };
  }

  if (rec.epoch !== epoch) {
    return {
      ok: false,
      reason: 'stale_epoch',
      detail: 'The page changed after this plan was made; the handle is no longer valid.',
    };
  }

  const el = rec.ref.deref();
  if (!el) {
    return { ok: false, reason: 'node_collected', detail: 'The target no longer exists.' };
  }

  if (!el.isConnected) {
    return {
      ok: false,
      reason: 'node_detached',
      detail: 'The target was removed from the page after it was observed.',
    };
  }

  if (window.location.origin !== rec.origin) {
    return {
      ok: false,
      reason: 'origin_changed',
      detail: `Observed on ${rec.origin}, now on ${window.location.origin}.`,
    };
  }

  const roleNow = liveRole(el);
  if (roleNow !== rec.role) {
    return {
      ok: false,
      reason: 'role_changed',
      detail: `Target was a ${rec.role} when observed and is now a ${roleNow}.`,
    };
  }

  if (expectedRole && roleNow !== expectedRole) {
    return {
      ok: false,
      reason: 'role_changed',
      detail: `Plan expected a ${expectedRole}, target is a ${roleNow}.`,
    };
  }

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return {
      ok: false,
      reason: 'not_visible',
      detail: 'The target is no longer visible.',
    };
  }

  return { ok: true, el };
}

/** Role as computed right now, so a swapped element fails the comparison. */
function liveRole(el: Element): string {
  const aria = el.getAttribute('role');
  if (aria) return aria;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const t = (el as HTMLInputElement).type;
    return t === 'checkbox' || t === 'radio' || t === 'submit' || t === 'button' ? t : 'textbox';
  }
  switch (tag) {
    case 'button': return 'button';
    case 'a': return 'link';
    case 'select': return 'select';
    case 'textarea': return 'textbox';
    default: return 'generic';
  }
}

// A new document means new handles. Navigation, history, and bfcache restore.
function rotateAll() {
  rotateEpoch();
  onRotate.forEach((fn) => fn());
}

window.addEventListener('pagehide', rotateAll);
window.addEventListener('popstate', rotateAll);
