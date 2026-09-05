import React from 'react';

export const Card: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <section className="card">{children}</section>
);

export const Section: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="section">{children}</div>
);

export const NoticeBar: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="notice" role="note">{children}</p>
);

export const Ref: React.FC<{ value: string }> = ({ value }) => (
  <code className="ref">{value}</code>
);

export const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="row"><dt>{label}</dt><dd>{children}</dd></div>
);

export const StatusPill: React.FC<{
  tone?: 'neutral' | 'ok' | 'warn' | 'stop';
  live?: boolean;
  children: React.ReactNode;
}> = ({ tone = 'neutral', live = false, children }) => (
  <span className={`pill${tone === 'neutral' ? '' : ` pill-${tone}`}`}>
    <span className={`dot${live ? ' dot-live' : ''}`} aria-hidden="true" />
    {children}
  </span>
);

export const PrimaryButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = (p) => (
  <button {...p} className="btn btn-primary" />
);

export const SecondaryButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = (p) => (
  <button {...p} className="btn btn-secondary" />
);

export const TabSwitcher: React.FC<{
  tabs: readonly string[]; active: string; onChange: (t: string) => void;
}> = ({ tabs, active, onChange }) => (
  <div className="tabs" role="tablist" aria-label="Panel view">
    {tabs.map((t) => (
      <button key={t} role="tab" className="tab" aria-selected={t === active}
        tabIndex={t === active ? 0 : -1} onClick={() => onChange(t)}>
        {t}
      </button>
    ))}
  </div>
);
