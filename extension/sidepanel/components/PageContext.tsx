import React from 'react';
import type { PageContextInfo } from '../types';

export const PageContext: React.FC<{ page: PageContextInfo | null }> = ({ page }) => (
  <div className="card" style={{ padding: '13px 18px' }}>
    <p className="sub" style={{ fontSize: 11.5 }}>Current page</p>
    <p style={{ margin: '2px 0 0', fontSize: 14.5, fontWeight: 500 }}>{page?.title ?? 'No page attached'}</p>
    <p className="sub mono" style={{ fontSize: 11.5 }}>{page?.origin ?? '—'}</p>
  </div>
);
