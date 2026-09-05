import React from 'react';
import { Card, Section, Row, NoticeBar } from './primitives';
import type { OutboundSummary } from '../types';

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
    <Card>
      <h2 className="h2">Outbound payload</h2>
      <Section>
        <dl style={{ margin: 0 }}>
          <Row label="Raw pixels sent">{outbound.rawPixelsSent}</Row>
          <Row label="Sensitive values sent">{outbound.piiValuesSent}</Row>
          <Row label="Fields described">{outbound.fieldsDescribed}</Row>
        </dl>
      </Section>
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
