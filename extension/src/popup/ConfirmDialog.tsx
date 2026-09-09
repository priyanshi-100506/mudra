import React, { useEffect, useRef } from 'react';
import type { GrantRequest } from '../shared/agent-events';

/**
 * The one authorisation in the flow.
 *
 * It is asked once, in this popup, before the page has been read — so it
 * states what the task may do rather than narrating an action already
 * planned. There is deliberately no second dialog later and none in the page:
 * a question that arrives mid-run, over the page, reads as an interruption,
 * and a user who is asked repeatedly stops reading and just clicks.
 */
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

  const permits = pending.permits ?? [];

  return (
    <div className="mudra-scrim" onKeyDown={onKeyDown}>
      <div ref={box} className="mudra-confirm" role="dialog" aria-modal="true"
        aria-labelledby="confirm-title">
        <p className="mudra-confirm-eyebrow">Authorisation required</p>
        <h2 id="confirm-title" className="mudra-confirm-q">{pending.sentence}</h2>

        <dl className="mudra-kv">
          <div><dt>Site</dt><dd className="mudra-kv-mono">{pending.origin}</dd></div>
          <div><dt>Task</dt><dd className="mudra-kv-mono">{pending.targetRef}</dd></div>
        </dl>

        {permits.length > 0 && (
          <>
            <p className="mudra-permits-head">This lets Mudra</p>
            <ul className="mudra-permits">
              {permits.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </>
        )}

        <div className="mudra-confirm-actions">
          <button ref={first} className="mudra-btn" onClick={onAuthorise}>Authorise</button>
          <button className="mudra-btn mudra-btn-ghost" onClick={onRefuse}>Cancel</button>
        </div>

        <p className="mudra-confirm-foot">
          {pending.uses === 1
            ? 'Covers this task, on this site. The form is submitted once.'
            : 'Covers this task, on this site. Anything else is refused.'}
        </p>
      </div>
    </div>
  );
};
