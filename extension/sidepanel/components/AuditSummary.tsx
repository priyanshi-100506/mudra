import React from 'react';
import { Card, Section, StatusPill } from './primitives';
import type { AuditEntry } from '../types';

export const AuditSummary: React.FC<{ audit: AuditEntry[] }> = ({ audit }) => {
  if (audit.length === 0) return null;
  return (
    <Card>
      <h2 className="h2">What happened</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {audit.map((e, i) => (
          <Section key={`${e.at}-${i}`}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <span style={{ fontSize: 13 }}>{e.effect}</span>
              <StatusPill tone={e.outcome === 'refused' ? 'stop' : 'ok'}>
                {e.outcome === 'refused' ? 'Refused' : 'Executed'}
              </StatusPill>
            </div>
            {e.reason && <p className="sub" style={{ marginTop: 6 }}>{e.reason}</p>}
          </Section>
        ))}
      </div>
    </Card>
  );
};
