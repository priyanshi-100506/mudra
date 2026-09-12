import React, { useEffect, useRef, useState } from 'react';
import type { AgentState, FeedItem, StageName, StageState } from '../types';
import { STAGES, stageStates } from '../state';
import { Icon, MarkIcon } from './icons';

const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toLocaleTimeString('en-GB', { hour12: false });
};

// ── Zone 1 · header ────────────────────────────────────────────────────────
const Header: React.FC = () => (
  <header className="lp-head">
    <span className="lp-mark"><MarkIcon /></span>
    <span className="lp-word">Mudra</span>
    <span className="lp-live">
      <span className="lp-live-dot" aria-hidden="true" />
      LIVE
    </span>
  </header>
);

// ── Zone 2 · counters ──────────────────────────────────────────────────────
const Counter: React.FC<{ value: number; label: string; tone?: 'ok' | 'no' }> = ({
  value, label, tone,
}) => {
  // The bump is applied to the number, never the cell, so the grid never moves.
  const [bump, setBump] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setBump(true);
    const t = window.setTimeout(() => setBump(false), 320);
    return () => window.clearTimeout(t);
  }, [value]);

  return (
    <div className="lp-cell">
      <div className={`lp-num${tone ? ` is-${tone}` : ''}${bump ? ' bump' : ''}`}>{value}</div>
      <div className="lp-clabel">{label}</div>
    </div>
  );
};

const Counters: React.FC<{ state: AgentState }> = ({ state }) => (
  <div className="lp-counters">
    <Counter value={state.outbound?.piiValuesSent ?? 0} label={'values\non wire'} tone="ok" />
    <Counter value={state.observed?.sensitive ?? 0} label={'sealed\nthis page'} />
    <Counter value={state.refused} label={'actions\nrefused'} tone={state.refused > 0 ? 'no' : undefined} />
  </div>
);

// ── Zone 3 · stage rail ────────────────────────────────────────────────────
const Rail: React.FC<{ state: AgentState }> = ({ state }) => {
  const states = stageStates(state.phase);
  return (
    <div className="lp-rail">
      {STAGES.map((name: StageName, i) => {
        const s: StageState = states[i];
        return (
          <div key={name} className={`lp-stage is-${s}`}>
            {i > 0 && <span className={`lp-conn${states[i - 1] === 'done' ? ' is-done' : ''}`} />}
            <span className="lp-dot" />
            <span className="lp-slabel">{name}</span>
          </div>
        );
      })}
    </div>
  );
};

// ── Zone 5 · feed ──────────────────────────────────────────────────────────
const Row: React.FC<{ item: FeedItem }> = ({ item }) => (
  <article className={`lp-card is-${item.kind}${item.replay ? ' is-replay' : ''}`}>
    <span className="lp-chip"><Icon name={item.icon} /></span>
    <div className="lp-body">
      <h3 className="lp-title">{item.title}</h3>
      {(item.detail || item.code) && (
        <p className="lp-detail">
          {item.code && <><code>{item.code}</code>{item.detail ? ' ' : ''}</>}
          {item.detail}
        </p>
      )}
      <p className="lp-time">{clock(item.at)}</p>
    </div>
  </article>
);

const Feed: React.FC<{ items: FeedItem[] }> = ({ items }) => {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  return (
    <div className="lp-feed" ref={box}>
      {items.length === 0
        ? <p className="lp-empty">Nothing observed yet.</p>
        : items.map((i) => <Row key={i.id} item={i} />)}
    </div>
  );
};

// ── the panel ──────────────────────────────────────────────────────────────
export const LivePanel: React.FC<{ state: AgentState; onReset: () => void }> = ({
  state, onReset,
}) => {
  const [now, setNow] = useState(() => new Date().toLocaleTimeString('en-GB', { hour12: false }));
  useEffect(() => {
    const t = window.setInterval(
      () => setNow(new Date().toLocaleTimeString('en-GB', { hour12: false })), 1000);
    return () => window.clearInterval(t);
  }, []);

  const values = state.outbound?.piiValuesSent ?? 0;
  const pixels = state.outbound?.rawPixelsSent ?? 0;

  return (
    <div className="lp">
      <Header />
      <Counters state={state} />
      <Rail state={state} />

      <div className="lp-feedhead">
        <span className="lp-feedlabel">Activity</span>
        <span className="lp-clock">{now}</span>
      </div>

      <Feed items={state.feed} />

      <footer className="lp-foot">
        <p className="lp-footline">
          <b>{values}</b> values and <b>{pixels}</b> raw pixels have left this device.
        </p>
        <button className="lp-btn" onClick={onReset}>New task</button>
      </footer>
    </div>
  );
};
