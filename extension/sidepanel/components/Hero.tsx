import React from 'react';
import { Card } from './primitives';

export const Hero: React.FC<{ origin: string | null; title: string | null }> = ({ origin, title }) => (
  <Card>
    <p className="hero">
      The agent sees this page.<br />
      <em>The server never does.</em>
    </p>
    <div className="section" style={{ marginTop: 16 }}>
      <p className="sub" style={{ fontSize: 12 }}>Attached to</p>
      <p style={{ margin: '3px 0 0', fontSize: 14, fontWeight: 500 }}>{title ?? 'No page yet'}</p>
      <p className="sub mono" style={{ marginTop: 1 }}>{origin ?? 'Open a website to begin'}</p>
    </div>
  </Card>
);
