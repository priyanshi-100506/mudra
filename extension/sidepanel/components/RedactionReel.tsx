import React, { useEffect, useState } from 'react';
import { Card } from './primitives';
import type { RedactedField } from '../../src/shared/agent-events';

const STEP_MS = 260;

export const RedactionReel: React.FC<{
  fields: RedactedField[];
  outboundReady: boolean;
}> = ({ fields, outboundReady }) => {
  const [sealed, setSealed] = useState(0);

  useEffect(() => {
    setSealed(0);
    if (fields.length === 0) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setSealed(fields.length); return; }
    const timers = fields.map((_, i) =>
      window.setTimeout(() => setSealed(i + 1), 240 + i * STEP_MS)
    );
    return () => timers.forEach(clearTimeout);
  }, [fields]);

  if (fields.length === 0) return null;
  const sealedCount = fields.slice(0, sealed).filter((f) => f.sensitive).length;

  return (
    <Card>
      <h2 className="h2">On this device</h2>
      <div className="reel">
        {fields.map((f, i) => (
          <div
            key={f.ref}
            className={`field${i < sealed && f.sensitive ? ' sealed' : ''}`}
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <span className="field-label">{f.label}</span>
            {f.sensitive ? (
              <>
                <span className="field-arrow" aria-hidden="true">→</span>
                <code className="field-ref">{f.ref}</code>
              </>
            ) : (
              <span className="field-safe">not sensitive</span>
            )}
          </div>
        ))}
      </div>

      <div className="boundary">
        <span className="boundary-line" />
        <span className="boundary-label">leaves the device</span>
        <span className="boundary-line" />
      </div>

      <p className="sub" aria-live="polite">
        {outboundReady
          ? `${sealedCount} value${sealedCount === 1 ? '' : 's'} replaced with references. Nothing below this line carries a real value.`
          : 'Sealing sensitive values…'}
      </p>
    </Card>
  );
};
