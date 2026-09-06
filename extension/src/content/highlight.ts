/**
 * On-page redaction overlay. Draws over sensitive fields as they are sealed,
 * so the user watches the mechanism happen on the page itself rather than
 * only in the popup. Purely visual — it reads no values and mutates nothing.
 */

const HOST_ID = 'mudra-highlight-host';
let host: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;
let timers: number[] = [];
let cleanupListeners: (() => void) | null = null;

const CSS = `
  :host { all: initial; }
  .layer {
    position: fixed; inset: 0; pointer-events: none;
    z-index: 2147483646;
  }
  .box {
    position: absolute;
    border: 1.5px solid #1B3AC4;
    background: rgba(27,58,196,.07);
    opacity: 0;
    transform: scale(.98);
    transition: opacity 180ms ease, transform 180ms cubic-bezier(.2,.8,.3,1);
  }
  .box.on { opacity: 1; transform: none; }
  .box.sealed {
    background: #0A0A0B;
    border-color: #0A0A0B;
    transition: background 220ms ease, border-color 220ms ease;
  }
  .tag {
    position: absolute; top: -19px; left: -1.5px;
    font: 500 9.5px/1 ui-monospace, 'SF Mono', Menlo, monospace;
    letter-spacing: .1em; text-transform: uppercase;
    color: #fff; background: #1B3AC4;
    padding: 4px 6px; white-space: nowrap;
    opacity: 0; transition: opacity 200ms ease;
  }
  .box.sealed .tag { opacity: 1; background: #0A0A0B; }
  .scan {
    position: absolute; left: 0; right: 0; height: 1px;
    background: #1B3AC4; opacity: .55;
    box-shadow: 0 0 14px 2px rgba(27,58,196,.35);
  }
`;

function mount(): ShadowRoot {
  if (shadow) return shadow;
  host = document.createElement('div');
  host.id = HOST_ID;
  document.documentElement.appendChild(host);
  shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.appendChild(style);
  const layer = document.createElement('div');
  layer.className = 'layer';
  shadow.appendChild(layer);
  return shadow;
}

function layer(): HTMLElement {
  return mount().querySelector('.layer') as HTMLElement;
}

export function clearHighlights() {
  timers.forEach(clearTimeout);
  timers = [];
  cleanupListeners?.();
  cleanupListeners = null;
  host?.remove();
  host = null;
  shadow = null;
}

/** A single downward sweep across the viewport — "reading the page". */
export function scanPage(durationMs = 900) {
  const root = layer();
  const line = document.createElement('div');
  line.className = 'scan';
  line.style.top = '0px';
  root.appendChild(line);

  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min((now - start) / durationMs, 1);
    line.style.top = `${t * window.innerHeight}px`;
    if (t < 1) requestAnimationFrame(step);
    else line.remove();
  };
  requestAnimationFrame(step);
}

export interface HighlightTarget {
  ref: string;
  elementId: string;
  sensitive: boolean;
}

/**
 * Outlines each target, then seals the sensitive ones one at a time.
 * `resolve` maps an element id back to a live node — the caller owns that
 * registry; this module never touches the DOM's values.
 */
export function runRedactionOverlay(
  targets: HighlightTarget[],
  resolve: (elementId: string) => Element | undefined,
  stepMs = 260,
) {
  clearHighlights();
  const root = layer();

  const firstSensitive = targets.find((t) => t.sensitive);
  const anchor = firstSensitive && resolve(firstSensitive.elementId);
  if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });

  scanPage();

  const boxes: { box: HTMLElement; sensitive: boolean; el: Element }[] = [];

  /** Rects are viewport-relative and go stale on scroll or reflow. */
  const place = (box: HTMLElement, el: Element) => {
    const r = el.getBoundingClientRect();
    box.style.left = `${r.left - 2}px`;
    box.style.top = `${r.top - 2}px`;
    box.style.width = `${r.width + 4}px`;
    box.style.height = `${r.height + 4}px`;
  };

  targets.forEach((t, i) => {
    const el = resolve(t.elementId);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;

    const box = document.createElement('div');
    box.className = 'box';
    place(box, el);

    if (t.sensitive) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = t.ref;
      box.appendChild(tag);
    }

    root.appendChild(box);
    boxes.push({ box, sensitive: t.sensitive, el });

    timers.push(window.setTimeout(() => box.classList.add('on'), 600 + i * 45));
  });

  // then seal the sensitive ones in sequence
  let n = 0;
  boxes.forEach(({ box, sensitive, el }) => {
    if (!sensitive) return;
    const delay = 1000 + n * stepMs;
    n += 1;
    timers.push(window.setTimeout(() => {
      place(box, el);
      box.classList.add('sealed');
    }, delay));
  });

  const reposition = () => boxes.forEach(({ box, el }) => place(box, el));
  window.addEventListener('scroll', reposition, { passive: true });
  window.addEventListener('resize', reposition, { passive: true });
  cleanupListeners = () => {
    window.removeEventListener('scroll', reposition);
    window.removeEventListener('resize', reposition);
  };

  // fade the whole layer once the sequence finishes
  timers.push(window.setTimeout(clearHighlights, 1000 + n * stepMs + 2200));
}
