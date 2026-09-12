/**
 * On-page redaction overlay. Draws over sensitive fields as they are sealed,
 * so the user watches the mechanism happen on the page itself rather than
 * only in the popup. Purely visual — it reads no values and mutates nothing.
 */

/**
 * The overlay lives in a shadow root on the host page, which cannot see the
 * panel's theme.css. These mirror the --p-* role tokens defined there and are
 * the single place this file names a colour; nothing below hardcodes one.
 */
const PALETTE = {
  sky: '#38BDF8',
  skyDim: 'rgba(56,189,248,.10)',
  seal: '#082F49',
  ink: '#FFFFFF',
};

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
    border: 1.5px solid ${PALETTE.sky};
    background: ${PALETTE.skyDim};
    opacity: 0;
    transform: scale(.98);
    transition: opacity 180ms ease, transform 180ms cubic-bezier(.2,.8,.3,1);
  }
  .box.on { opacity: 1; transform: none; }
  .box.sealed {
    background: ${PALETTE.seal};
    border-color: ${PALETTE.seal};
    transition: background 220ms ease, border-color 220ms ease;
  }
  .tag {
    position: absolute; top: -19px; left: -1.5px;
    font: 500 9.5px/1 ui-monospace, 'SF Mono', Menlo, monospace;
    letter-spacing: .1em; text-transform: uppercase;
    color: ${PALETTE.ink}; background: ${PALETTE.sky};
    padding: 4px 6px; white-space: nowrap;
    opacity: 0; transition: opacity 200ms ease;
  }
  .box.sealed .tag { opacity: 1; background: ${PALETTE.seal}; }
  .scan {
    position: absolute; left: 0; right: 0; height: 1px;
    background: ${PALETTE.sky}; opacity: .55;
    box-shadow: 0 0 14px 2px ${PALETTE.skyDim};
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

  // Only sensitive fields are drawn. A field we deliberately left visible
  // gets no overlay at all — the contrast between the two is the argument.
  const sensitive = targets.filter((t) => t.sensitive);

  sensitive.forEach((t, i) => {
    const el = resolve(t.elementId);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;

    const box = document.createElement('div');
    box.className = 'box';
    place(box, el);

    // The ref is shown on the page as well as in the panel, so the audience
    // can see both surfaces naming the same handle.
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = t.ref;
    box.appendChild(tag);

    root.appendChild(box);
    boxes.push({ box, sensitive: true, el });

    // Staggered, so detection reads as something happening rather than one
    // flash of everything at once.
    timers.push(window.setTimeout(() => box.classList.add('on'), 600 + i * 60));
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

  // Rects are viewport-relative, so every scroll and resize invalidates them.
  // A seal that drifts under the page destroys the illusion instantly, and a
  // seal recomputed per scroll event costs a layout read per event — so this
  // coalesces to one repositioning pass per frame.
  //
  // getBoundingClientRect and a position:fixed layer are both in CSS pixels,
  // so this is already correct under devicePixelRatio; no manual scaling.
  let frame = 0;
  const reposition = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      boxes.forEach(({ box, el }) => place(box, el));
    });
  };
  window.addEventListener('scroll', reposition, { passive: true, capture: true });
  window.addEventListener('resize', reposition, { passive: true });
  cleanupListeners = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    window.removeEventListener('scroll', reposition, { capture: true } as EventListenerOptions);
    window.removeEventListener('resize', reposition);
  };

  // fade the whole layer once the sequence finishes
  timers.push(window.setTimeout(clearHighlights, 1000 + n * stepMs + 2200));
}
