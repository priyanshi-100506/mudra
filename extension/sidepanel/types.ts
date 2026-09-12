export type {
  AgentPhase, DetectionCounts, RedactionCounts,
  OutboundSummary, GrantRequest as PendingAction,
  RedactedField,
} from '../src/shared/agent-events';

export interface PageContextInfo { origin: string; title: string }

export interface AuditEntry {
  at: string;
  effect: string;
  outcome: 'executed' | 'refused';
  reason?: string;
}

import type {
  AgentPhase, DetectionCounts, RedactionCounts, OutboundSummary, GrantRequest, RedactedField,
} from '../src/shared/agent-events';

/** The four kinds the feed renders, per the design spec. */
export type FeedKind = 'seal' | 'send' | 'exec' | 'refuse';
export type IconName = 'eye' | 'seal' | 'up' | 'check' | 'stop' | 'log';

export interface FeedItem {
  /** Derived from the emitter's seq, so a replay cannot duplicate a row. */
  id: string;
  kind: FeedKind;
  icon: IconName;
  title: string;
  detail?: string;
  /** Rendered in an inline <code> chip inside the detail line. */
  code?: string;
  /** ISO, stamped by the worker when the event was emitted. */
  at: string;
  /** History being replayed — render it, but do not animate it. */
  replay: boolean;
}

/** see -> seal -> send -> gate -> log */
export type StageName = 'see' | 'seal' | 'send' | 'gate' | 'log';
export type StageState = 'idle' | 'active' | 'done';

export interface AgentState {
  phase: AgentPhase;
  page: PageContextInfo | null;
  task: string | null;
  detection: DetectionCounts | null;
  redaction: RedactionCounts | null;
  fields: RedactedField[];
  outbound: OutboundSummary | null;
  pending: GrantRequest | null;
  audit: AuditEntry[];
  error: string | null;
  /** The live feed, oldest first. Capped; see FEED_CAP. */
  feed: FeedItem[];
  /** Totals from the most recent observation pass. */
  observed: { elements: number; sensitive: number } | null;
  /** Emitter seqs already folded in, so a replay does not double-count. */
  seen: number[];
  /** Monotonic: how many actions the gate has refused this run. */
  refused: number;
}

/** Event envelope carried alongside every worker event. */
export interface EventMeta { at?: string; seq?: number; replay?: boolean }
