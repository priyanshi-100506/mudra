import React from 'react';
import { Card } from './primitives';
import type { PageContextInfo } from '../types';

export const PageContext: React.FC<{ page: PageContextInfo | null }> = ({ page }) => (
  <Card>
    <p className="sub">Current page</p>
    <p className="h2" style={{ margin: '2px 0 0' }}>{page?.title ?? 'No page attached'}</p>
    <p className="sub mono">{page?.origin ?? '—'}</p>
  </Card>
);
