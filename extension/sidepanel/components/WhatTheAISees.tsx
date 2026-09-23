import React, { useEffect, useRef, useState } from 'react';
import { Card, Section } from './primitives';
import {
  EVIDENCE_PORT, compressionLine, formatBytes,
  type VisualEvidencePacket, type StageTimings,
} from '../../src/shared/evidence';

/**
 * The demo moment: the real capture beside the image actually sent.
 *
 * The left pane is raw, unredacted pixels. It is rendered here and nowhere
 * else — the packet arrives over a direct runtime port, is held in a ref, and
 * is dropped on unmount. It never touches chrome.storage and never enters a
 * payload. Holding it in a ref rather than in state is the point: state gets
 * serialised into devtools snapshots and, sooner or later, into something
 * that persists.
 */

const LABEL_COLOURS: Record<string, string> = {
  FACE: '#ff6b35',
  AADHAAR: '#e63946',
  PAN: '#e63946',
  CARD: '#e63946',
  PASSWORD: '#7209b7',
  OTP: '#7209b7',
  PHONE: '#7209b7',
  EMAIL: '#7209b7',
  'HINDI-OCR': '#06a77d',
  'NOT READ': '#6c757d',
};

const labelColour = (label: string) => LABEL_COLOURS[label] ?? '#e63946';

/**
 * Draws the redacted image with its masks outlined and named.
 *
 * Labels are sized off the rendered width rather than fixed in px, because
 * this gets projected. A 10px caption is unreadable from the back of a room,
 * and the labels are the whole reason the right-hand pane is legible at all.
 */
const MaskOverlay: React.FC<{ packet: VisualEvidencePacket; width: number }> = ({ packet, width }) => {
  const scale = packet.width > 0 ? width / packet.width : 1;
  const fontSize = Math.max(11, Math.round(width / 28));

  return (
    <svg
      viewBox={`0 0 ${packet.width} ${packet.height}`}
      width={width}
      height={packet.height * scale}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      aria-hidden
    >
      {packet.masks.map((m, i) => {
        const colour = labelColour(m.label);
        const fs = fontSize / scale;
        return (
          <g key={i}>
            <rect
              x={m.x} y={m.y} width={m.width} height={m.height}
              fill="none" stroke={colour} strokeWidth={Math.max(2, 3 / scale)}
            />
            <rect
              x={m.x} y={Math.max(0, m.y - fs * 1.35)}
              width={m.label.length * fs * 0.62 + fs * 0.5} height={fs * 1.3}
              fill={colour}
            />
            <text
              x={m.x + fs * 0.25} y={Math.max(fs, m.y - fs * 0.35)}
              fill="#fff" fontSize={fs} fontWeight={700}
              fontFamily="ui-monospace, SFMono-Regular, monospace"
            >
              {m.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

const STAGES: Array<[keyof StageTimings, string]> = [
  ['capture', 'Capture'],
  ['faces', 'Faces'],
  ['ocr', 'OCR'],
  ['redact', 'Redact'],
  ['verify', 'Verify'],
  ['network', 'Network'],
];

const Waterfall: React.FC<{ timings: StageTimings }> = ({ timings }) => {
  const total = STAGES.reduce((sum, [k]) => sum + (timings[k] as number), 0);
  const peak = Math.max(1, ...STAGES.map(([k]) => timings[k] as number));

  return (
    <div>
      {STAGES.map(([key, label]) => {
        const ms = timings[key] as number;
        return (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
            <span className="sub" style={{ width: 62, fontSize: 12 }}>{label}</span>
            <div style={{ flex: 1, height: 8, background: 'rgba(127,127,127,.15)', borderRadius: 4 }}>
              <div style={{
                width: `${(ms / peak) * 100}%`, height: '100%',
                background: 'var(--accent, #4361ee)', borderRadius: 4,
              }} />
            </div>
            <span style={{ width: 52, textAlign: 'right', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
              {ms} ms
            </span>
          </div>
        );
      })}
      <div className="sub" style={{ fontSize: 12, marginTop: 6, display: 'flex', justifyContent: 'space-between' }}>
        <span>Total {total} ms</span>
        {timings.heapMb !== undefined && <span>Peak heap {timings.heapMb} MB</span>}
      </div>
    </div>
  );
};

/** The right-hand pane when nothing was sent. Failing closed is a feature. */
const NothingSent: React.FC<{ reason?: string }> = ({ reason }) => (
  <div style={{
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 8, padding: 24, minHeight: 140, textAlign: 'center',
    border: '2px dashed rgba(127,127,127,.45)', borderRadius: 8,
  }}>
    <strong style={{ fontSize: 14 }}>No image sent</strong>
    <span className="sub" style={{ fontSize: 12, maxWidth: 260 }}>
      {reason ?? 'Redaction could not be verified, so nothing was sent.'}
    </span>
    <span className="sub" style={{ fontSize: 11, opacity: 0.8 }}>
      This is the fail-closed path working, not a failure to render.
    </span>
  </div>
);

export const WhatTheAISees: React.FC = () => {
  // The raw capture lives here and only here. A ref, not state: state ends up
  // in devtools snapshots and eventually in something that persists.
  const packetRef = useRef<VisualEvidencePacket | null>(null);
  const [version, setVersion] = useState(0);
  const [paneWidth, setPaneWidth] = useState(320);
  const paneEl = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const port = chrome.runtime.connect({ name: EVIDENCE_PORT });
    port.onMessage.addListener((msg: VisualEvidencePacket) => {
      packetRef.current = msg;
      setVersion((v) => v + 1);
    });
    return () => {
      port.disconnect();
      // Drop the pixels the moment nobody is looking at them.
      packetRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!paneEl.current) return;
    const ro = new ResizeObserver(([entry]) => setPaneWidth(entry.contentRect.width));
    ro.observe(paneEl.current);
    return () => ro.disconnect();
  }, [version]);

  const packet = packetRef.current;
  if (!packet) return null;

  const ratio = compressionLine(packet.sizes);

  return (
    <Card>
      <h2 className="h2">What the AI sees</h2>

      <Section>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <figure style={{ margin: 0 }}>
            <figcaption className="sub" style={{ fontSize: 12, marginBottom: 4 }}>
              On your screen — never leaves this device
            </figcaption>
            <img
              src={packet.rawDataUrl}
              alt="The page as captured, before redaction"
              style={{ width: '100%', display: 'block', borderRadius: 6 }}
            />
          </figure>

          <figure style={{ margin: 0 }} ref={paneEl}>
            <figcaption className="sub" style={{ fontSize: 12, marginBottom: 4 }}>
              Sent to the planner{packet.reOcrVerified ? ' — verified clean' : ''}
            </figcaption>
            {packet.redactedDataUrl ? (
              <div style={{ position: 'relative' }}>
                <img
                  src={packet.redactedDataUrl}
                  alt="The redacted image that was sent"
                  style={{ width: '100%', display: 'block', borderRadius: 6 }}
                />
                <MaskOverlay packet={packet} width={paneWidth} />
              </div>
            ) : (
              <NothingSent reason={packet.withheld} />
            )}
          </figure>
        </div>
      </Section>

      <Section>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {[...new Set(packet.masks.map((m) => m.label))].map((label) => (
            <span key={label} style={{
              fontSize: 11, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
              background: labelColour(label), color: '#fff',
              fontFamily: 'ui-monospace, monospace',
            }}>
              {label}
            </span>
          ))}
        </div>
      </Section>

      <Section>
        <Waterfall timings={packet.timings} />
      </Section>

      <Section>
        <div style={{ fontSize: 13 }}>
          {/* Measured, not estimated. This figure has to survive a question. */}
          {ratio ?? `sent ${formatBytes(packet.sizes.sentBytes)}; no image was captured to compare against`}
        </div>
        <div className="sub" style={{ fontSize: 12, marginTop: 4 }}>
          Canary tokens: {packet.canaries.planted} planted, {packet.canaries.escaped} escaped
          {packet.provider && ` · inference on ${packet.provider}`}
        </div>
      </Section>

      <details>
        <summary className="sub" style={{ cursor: 'pointer' }}>The exact JSON body posted</summary>
        {/* As sent. Not re-serialised for display — a prettified copy would
            be a different string from the one the canary scan ran against. */}
        <pre style={{
          margin: '6px 0 0', fontSize: 11, maxHeight: 260, overflow: 'auto',
          background: 'rgba(127,127,127,.08)', padding: 8, borderRadius: 6,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {packet.sentBody}
        </pre>
      </details>
    </Card>
  );
};
