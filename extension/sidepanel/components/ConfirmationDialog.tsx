import React, { useEffect, useRef } from 'react';
import { Section, Row, PrimaryButton, SecondaryButton, Ref } from './primitives';
import type { PendingAction } from '../types';

export const ConfirmationDialog: React.FC<{
  pending: PendingAction;
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
    if (items.length === 0) return;
    const a = items[0];
    const z = items[items.length - 1];
    if (e.shiftKey && document.activeElement === a) { z.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === z) { a.focus(); e.preventDefault(); }
  };

  return (
    <div className="scrim" onKeyDown={onKeyDown}>
      <div ref={box} className="card" role="dialog" aria-modal="true"
        aria-labelledby="confirm-title" style={{ maxWidth: 340, width: '100%' }}>
        <h2 id="confirm-title" className="h1">{pending.sentence}</h2>
        <div style={{ marginTop: 14 }}>
          <Section>
            <dl style={{ margin: 0 }}>
              <Row label="Origin"><span className="mono">{pending.origin}</span></Row>
              <Row label="Effect">{pending.effect}</Row>
              <Row label="Target field">
                {pending.targetRole} <Ref value={pending.targetRef} />
              </Row>
            </dl>
          </Section>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
          <PrimaryButton ref={first} onClick={onAuthorise}>Authorise once</PrimaryButton>
          <SecondaryButton onClick={onRefuse}>Refuse</SecondaryButton>
        </div>
        <p className="sub" style={{ marginTop: 12, textAlign: 'center' }}>
          This authorises one action, on this page, once.
        </p>
      </div>
    </div>
  );
};
