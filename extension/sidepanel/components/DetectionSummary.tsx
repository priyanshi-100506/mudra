import React from 'react';
import { Card, Section, Row } from './primitives';
import type { DetectionCounts, RedactionCounts } from '../types';

export const DetectionSummary: React.FC<{
  detection: DetectionCounts | null;
  redaction: RedactionCounts | null;
}> = ({ detection, redaction }) => {
  if (!detection) return null;
  return (
    <Card>
      <h2 className="h2">Protected locally</h2>
      <Section>
        <dl style={{ margin: 0 }}>
          <Row label="Structured identifiers">{detection.structuredPii}</Row>
          <Row label="Faces">{detection.faces}</Row>
          <Row label="Names and addresses">{detection.namedEntities}</Row>
          <Row label="Text found in images">{detection.ocrRegions}</Row>
        </dl>
      </Section>
      {redaction && (
        <div style={{ marginTop: 10 }}>
          <Section>
            <dl style={{ margin: 0 }}>
              <Row label="Replaced with references">{redaction.textReferences}</Row>
              <Row label="Masked image regions">{redaction.maskedRegions}</Row>
              <Row label="Re-checked before sending">{redaction.reOcrVerified ? 'Yes' : 'Pending'}</Row>
            </dl>
          </Section>
        </div>
      )}
    </Card>
  );
};
