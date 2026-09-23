import React from 'react';
import { Card, Section, SecondaryButton } from './primitives';

/**
 * Shown when a canary reached the serialised outbound body.
 *
 * This is deliberately not the error card. An error is something that went
 * wrong; this is the strongest safety property in MUDRA firing correctly, and
 * it has to read that way to someone watching from across a room. The worst
 * possible presentation of the best thing this system does would be a silent
 * stop that looks like a crash.
 *
 * The kinds that escaped are named. The values are not — reporting a leaked
 * tracer by printing it would leak it again, into the panel this time.
 */
export const BlockedState: React.FC<{
  blocked: { title: string; detail: string; planted: number; escaped: number; escapedKinds: string[] };
  onRetry: () => void;
}> = ({ blocked, onRetry }) => (
  <Card>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span aria-hidden style={{ fontSize: 20, lineHeight: 1 }}>⛔</span>
      <h2 className="h2" style={{ margin: 0 }}>{blocked.title}</h2>
    </div>

    <Section>
      <p className="sub" style={{ margin: 0 }}>
        A tracer value planted in this page reached the request body. The
        request was aborted before it was sent, and this session has stopped.
      </p>
    </Section>

    <Section>
      <dl style={{ margin: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
          <dt className="sub">Canary tokens</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>
            {blocked.planted} planted, {blocked.escaped} escaped
          </dd>
        </div>
        {blocked.escapedKinds.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
            <dt className="sub">Kinds that escaped</dt>
            <dd style={{ margin: 0, fontFamily: 'ui-monospace, monospace' }}>
              {blocked.escapedKinds.join(', ')}
            </dd>
          </div>
        )}
      </dl>
    </Section>

    <Section>
      <p className="sub" style={{ margin: 0, fontSize: 12 }}>
        This is a redaction fault, not a policy decision. Nothing was sent, and
        MUDRA will not retry this page until the fault is fixed.
      </p>
    </Section>

    <details style={{ marginTop: 10 }}>
      <summary className="sub" style={{ cursor: 'pointer' }}>Details</summary>
      <p className="sub" style={{ margin: '6px 0 0', fontSize: 12, wordBreak: 'break-word' }}>
        {blocked.detail}
      </p>
    </details>

    <div style={{ marginTop: 12 }}>
      <SecondaryButton onClick={onRetry}>Start over</SecondaryButton>
    </div>
  </Card>
);
