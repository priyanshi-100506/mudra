import React from 'react';
import { Card, Section, NoticeBar } from './primitives';
import type { OutboundSummary } from '../types';

const Stat: React.FC<{ n: number; label: string }> = ({ n, label }) => (
  <div className="stat">
    <div className={`stat-num${n === 0 ? ' zero' : ''}`}>{n}</div>
    <div className="stat-label">{label}</div>
  </div>
);

export const OutboundPayload: React.FC<{ outbound: OutboundSummary | null }> = ({ outbound }) => {
  if (!outbound) {
    return (
      <Card>
        <h2 className="h2">Outbound payload</h2>
        <p className="sub">Nothing has been prepared to send yet.</p>
      </Card>
    );
  }
  return (
    <Card className="card-lift">
      <h2 className="h2">Leaving this device</h2>
      <div className="stat-grid">
        <Stat n={outbound.rawPixelsSent} label="Raw pixels sent" />
        <Stat n={outbound.piiValuesSent} label="Sensitive values sent" />
      </div>
      <div style={{ marginTop: 8 }}>
        <div className="stat">
          <div className="stat-num">{outbound.fieldsDescribed}</div>
          <div className="stat-label">Fields described to the planner</div>
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <Section><pre className="payload">{outbound.preview}</pre></Section>
      </div>
      <div style={{ marginTop: 10 }}>
        <NoticeBar>
          Sensitive values are replaced with references before anything leaves this device.
        </NoticeBar>
      </div>
    </Card>
  );
};
