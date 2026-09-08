/**
 * In-page confirmation.
 *
 * A confirmation that lives in a browser-action popup is not a reliable
 * control — popups unmount the moment focus moves, leaving the worker waiting
 * on a decision the user never saw. This renders over the page the action
 * would affect, which is both more reliable and more honest: the question is
 * asked where the consequence lands.
 *
 * Shadow root with `all: initial` so no page CSS reaches it and none of ours
 * escapes.
 */

export interface ConfirmRequest {
  sentence: string;
  origin: string;
  effect: string;
  targetRole: string;
  targetRef: string;
}

const HOST_ID = 'mudra-confirm-host';
let host: HTMLElement | null = null;
let resolver: ((d: 'authorise' | 'refuse') => void) | null = null;

const CSS = `
  :host { all: initial; }
  .scrim {
    position: fixed; inset: 0; z-index: 2147483647;
    background: rgba(10,10,11,.38);
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, 'Segoe UI', Helvetica, sans-serif;
    animation: fade 140ms ease;
  }
  @keyframes fade { from { opacity: 0 } to { opacity: 1 } }
  .card {
    width: 400px; max-width: calc(100vw - 40px);
    background: #FCFCFA; border: 1px solid #0A0A0B; padding: 24px;
    animation: rise 200ms cubic-bezier(.2,.8,.3,1);
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(10px) }
    to { opacity: 1; transform: none }
  }
  .eyebrow {
    font: 500 9px/1 ui-monospace, 'SF Mono', Menlo, monospace;
    letter-spacing: .22em; text-transform: uppercase;
    color: #96979D; margin: 0 0 11px;
  }
  h2 {
    font-size: 19px; font-weight: 400; letter-spacing: -.022em;
    line-height: 1.25; color: #0A0A0B; margin: 0 0 20px;
  }
  dl { margin: 0 0 22px; border-top: 1px solid #E5E4DF; }
  .row {
    display: flex; justify-content: space-between; align-items: baseline;
    gap: 14px; padding: 9px 0; border-bottom: 1px solid #E5E4DF;
  }
  dt {
    font: 500 9.5px/1 ui-monospace, Menlo, monospace;
    letter-spacing: .16em; text-transform: uppercase; color: #96979D; margin: 0;
  }
  dd {
    margin: 0; font: 400 11px/1.4 ui-monospace, Menlo, monospace;
    color: #0A0A0B; text-align: right; word-break: break-all;
  }
  .actions { display: flex; flex-direction: column; gap: 8px; }
  button {
    width: 100%; padding: 13px 24px; border-radius: 0; cursor: pointer;
    font: 600 11px/1 -apple-system, sans-serif;
    letter-spacing: .18em; text-transform: uppercase;
  }
  .go { background: #0A0A0B; color: #FCFCFA; border: 1px solid #0A0A0B; }
  .go:hover { background: #000; }
  .no { background: transparent; color: #0A0A0B; border: 1px solid #CFCEC8; }
  .no:hover { background: #F2F1EC; }
  .foot {
    font: 400 9.5px/1.5 ui-monospace, Menlo, monospace;
    letter-spacing: .06em; color: #96979D; margin: 14px 0 0; text-align: center;
  }
  @media (prefers-reduced-motion: reduce) {
    .scrim, .card { animation: none }
  }
`;

function close() {
  host?.remove();
  host = null;
}

/** Shows the dialog and resolves with the user's decision. */
export function askConfirmation(req: ConfirmRequest): Promise<'authorise' | 'refuse'> {
  close();

  return new Promise((resolve) => {
    resolver = (d) => { close(); resolver = null; resolve(d); };

    host = document.createElement('div');
    host.id = HOST_ID;
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML = `
      <div class="card" role="dialog" aria-modal="true" aria-labelledby="mudra-q">
        <p class="eyebrow">Authorisation required</p>
        <h2 id="mudra-q"></h2>
        <dl>
          <div class="row"><dt>Origin</dt><dd class="v-origin"></dd></div>
          <div class="row"><dt>Effect</dt><dd class="v-effect"></dd></div>
          <div class="row"><dt>Target</dt><dd class="v-target"></dd></div>
        </dl>
        <div class="actions">
          <button class="go">Authorise once</button>
          <button class="no">Refuse</button>
        </div>
        <p class="foot">This authorises one action, on this page, once.</p>
      </div>`;
    shadow.appendChild(scrim);

    // textContent, never innerHTML — page-derived strings are untrusted input
    const q = shadow.querySelector('#mudra-q') as HTMLElement;
    q.textContent = req.sentence;
    (shadow.querySelector('.v-origin') as HTMLElement).textContent = req.origin;
    (shadow.querySelector('.v-effect') as HTMLElement).textContent = req.effect;
    (shadow.querySelector('.v-target') as HTMLElement).textContent =
      `${req.targetRole} · ${req.targetRef}`;

    const go = shadow.querySelector('.go') as HTMLButtonElement;
    const no = shadow.querySelector('.no') as HTMLButtonElement;
    go.addEventListener('click', () => resolver?.('authorise'));
    no.addEventListener('click', () => resolver?.('refuse'));

    // Escape refuses. Silence is never consent.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        window.removeEventListener('keydown', onKey, true);
        resolver?.('refuse');
      }
    };
    window.addEventListener('keydown', onKey, true);

    go.focus();
  });
}

export function dismissConfirmation() {
  resolver?.('refuse');
}
