import React, { useEffect, useRef } from 'react';
import type { PendingAction } from '../types';
import { Icon } from './icons';

/**
 * The authorisation control.
 *
 * This is a security control, not a modal. Every string comes from
 * `taskSentence`, `grantSummary` and `confirmSentence` by way of the grant
 * the worker built — none of the copy is written here, because the wording
 * was designed alongside the gate that enforces it.
 *
 * The two buttons carry equal visual weight on purpose. A confirmation whose
 * "allow" is styled as the obvious default has already been decided, and
 * users learn to click it without reading. For the same reason focus lands on
 * the dialog itself rather than on either choice.
 */
export const ConfirmationDialog: React.FC<{
  pending: PendingAction;
  onAuthorise: () => void;
  onRefuse: () => void;
}> = ({ pending, onAuthorise, onRefuse }) => {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => { box.current?.focus(); }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onRefuse(); return; }
    if (e.key !== 'Tab' || !box.current) return;
    const items = box.current.querySelectorAll<HTMLElement>('button');
    if (items.length === 0) return;
    const a = items[0];
    const z = items[items.length - 1];
    if (e.shiftKey && document.activeElement === a) { z.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === z) { a.focus(); e.preventDefault(); }
  };

  const permits = pending.permits ?? [];

  return (
    <div className="cg-scrim" onKeyDown={onKeyDown}>
      <div
        ref={box}
        tabIndex={-1}
        className="cg-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cg-title"
      >
        <p className="cg-eyebrow">Authorisation required</p>
        <h2 id="cg-title" className="cg-q">{pending.sentence}</h2>

        <dl className="cg-kv">
          <div>
            <dt>Site</dt>
            {/* Unabbreviated. The grant is bound to this origin; hiding any
                part of it hides what is being authorised. */}
            <dd className="cg-mono">{pending.origin}</dd>
          </div>
          <div>
            <dt>Task</dt>
            <dd className="cg-mono">{pending.targetRef}</dd>
          </div>
        </dl>

        {permits.length > 0 && (
          <>
            <p className="cg-permits-head">This lets Mudra</p>
            <ul className="cg-permits">
              {permits.map((line) => (
                <li key={line}>
                  <Icon name="check" size={11} />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="cg-actions">
          <button className="cg-btn" onClick={onAuthorise}>Authorise</button>
          <button className="cg-btn" onClick={onRefuse}>Cancel</button>
        </div>

        <p className="cg-foot">
          {pending.uses === 1
            ? 'Covers this task, on this site. The form is submitted once.'
            : 'Covers this task, on this site. Anything else is refused.'}
        </p>
      </div>
    </div>
  );
};
