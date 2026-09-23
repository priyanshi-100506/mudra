import React from 'react';
import { Card, Section, Row } from './primitives';
import type { DetectionCounts, RedactionCounts } from '../types';

export const DetectionSummary: React.FC<{
  detection: DetectionCounts | null;
  redaction: RedactionCounts | null;
  planner?: {
    planner: string; offline: boolean; model?: string | null;
    healthy: boolean; detail?: string | null;
  } | null;
}> = ({ detection, redaction, planner }) => {
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
      {/*
        Named, not assumed. A stub that is running says it is running, so
        "the plans got worse" cannot be mistaken for "the backend changed".
      */}
      {planner && (
        <Section>
          <dl style={{ margin: 0 }}>
            <Row label="Planner">
              <span style={{ color: planner.healthy ? undefined : 'var(--danger, #c0392b)' }}>
                {planner.planner}
                {planner.model ? ` · ${planner.model}` : ''}
                {planner.offline ? ' · on this device' : ''}
                {planner.healthy ? '' : ' · unavailable'}
              </span>
            </Row>
            {planner.detail && (
              <Row label="">
                <span className="sub" style={{ fontSize: 11 }}>{planner.detail}</span>
              </Row>
            )}
          </dl>
        </Section>
      )}
      {redaction && (
        <div style={{ marginTop: 10 }}>
          <Section>
            <dl style={{ margin: 0 }}>
              <Row label="Replaced with references">{redaction.textReferences}</Row>
              <Row label="Masked image regions">{redaction.maskedRegions}</Row>
              <Row label="Re-checked before sending">{redaction.reOcrVerified ? 'Yes' : 'Pending'}</Row>
              {/*
                Not a claim that nothing leaked — a result. Three fake but
                structurally valid identifiers were planted in the page and in
                the OCR stream, travelled the same code as real values, and
                the serialised request body was searched for them before it
                was sent.
              */}
              {redaction.canariesPlanted !== undefined && (
                <Row label="Canary tokens">
                  <span style={{ color: redaction.canariesEscaped ? 'var(--danger, #c0392b)' : undefined }}>
                    {redaction.canariesPlanted} planted, {redaction.canariesEscaped ?? 0} escaped
                  </span>
                </Row>
              )}
            </dl>
          </Section>
        </div>
      )}
    </Card>
  );
};
