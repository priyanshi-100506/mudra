import React, { useEffect, useRef } from 'react';
import type { GrantRequest } from '../shared/agent-events';

export const ConfirmDialog: React.FC<{
  pending: GrantRequest;
  onAuthorise: () => void;
  onRefuse: () => void;
}> = ({ pending, onAuthorise, onRefuse }) => {
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => { first.current?.focus(); }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onRefuse(); return; }
    if (e.key !== 'Tab' || !box.current) return;
    const items = box.current.querySelectorAll<HTMLElement>('button');
    if (!items.length) return;
    const a = items[0];
    const z = items[items.length - 1];
    if (e.shiftKey && document.activeElement === a) { z.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === z) { a.focus(); e.preventDefault(); }
  };

  return (
    <div className="mudra-scrim" onKeyDown={onKeyDown}>
      <div ref={box} className="mudra-confirm" role="dialog" aria-modal="true"
        aria-labelledby="confirm-title">
        <p className="mudra-confirm-eyebrow">Authorisation required</p>
        <h2 id="confirm-title" className="mudra-confirm-q">{pending.sentence}</h2>

        <dl className="mudra-kv">
          <div><dt>Origin</dt><dd className="mudra-kv-mono">{pending.origin}</dd></div>
          <div><dt>Effect</dt><dd className="mudra-kv-mono">{pending.effect}</dd></div>
          <div><dt>Target</dt><dd className="mudra-kv-mono">{pending.targetRef}</dd></div>
        </dl>

        <div className="mudra-confirm-actions">
          <button ref={first} className="mudra-btn" onClick={onAuthorise}>Authorise once</button>
          <button className="mudra-btn mudra-btn-ghost" onClick={onRefuse}>Refuse</button>
        </div>

        <p className="mudra-confirm-foot">
          This authorises one action, on this page, once.
        </p>
      </div>
    </div>
  );
};
