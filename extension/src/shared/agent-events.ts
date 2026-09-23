import type { BoundingBox } from './types';

/**
 * Safe scene-graph element. Deliberately has no `value` field —
 * this is the type that may cross the trust boundary.
 */
export interface SceneElement {
  ref: string;
  role: string;
  name: string;
  input_type?: string | null;
  sensitive: boolean;
  bbox?: BoundingBox | null;
}

export interface SceneGraph {
  origin: string;
  title: string;
  document_epoch: string;
  elements: SceneElement[];
  masked_regions: BoundingBox[];
  observed_at: string;
}

export interface DetectionCounts {
  structuredPii: number;
  faces: number;
  namedEntities: number;
  ocrRegions: number;
}

/** Safe to show. Carries no resolved value — by construction. */
export interface RedactedField {
  ref: string;
  label: string;
  role: string;
  sensitive: boolean;
  /**
   * The live element id, for on-device use only — the redaction overlay and
   * the action executor. Never included in the outbound payload.
   */
  elementId: string;
}

export interface RedactionCounts {
  textReferences: number;
  maskedRegions: number;
  reOcrVerified: boolean;
  /** "3 planted, 0 escaped". Counts only — never the tracer values. */
  canariesPlanted?: number;
  canariesEscaped?: number;
}

export interface OutboundSummary {
  rawPixelsSent: 0;
  piiValuesSent: 0;
  fieldsDescribed: number;
  preview: string;
}

export interface GrantRequest {
  sentence: string;
  origin: string;
  effect: string;
  targetRole: string;
  targetRef: string;
  /** What the authorisation covers, in plain language, for the dialog. */
  permits?: string[];
  /** How many times a high-impact effect may run under this grant. */
  uses?: number;
}

export type AgentPhase =
  | 'IDLE' | 'CAPTURING' | 'DETECTING' | 'REDACTING' | 'BUILDING_SCENE'
  | 'PLANNING' | 'AWAITING_CONFIRMATION' | 'EXECUTING'
  | 'COMPLETE' | 'REFUSED' | 'ERROR'
  /**
   * The redactor is broken and the session has stopped for good.
   *
   * Distinct from ERROR on purpose. An error is something that went wrong;
   * this is MUDRA's strongest safety property firing, and it has to read that
   * way to anyone watching. A hard stop that looks like a crash is the worst
   * possible presentation of the best thing this system does.
   */
  | 'BLOCKED';

/** Emitted by the service worker; consumed by the side panel only. */
export type AgentEventBody =
  | { type: 'AGENT_PHASE'; phase: AgentPhase }
  /**
   * One observation pass. `elements` is every interactive element the
   * perception layer described; `sensitive` is how many of those were sealed.
   * The panel needs the total at observation time — every other event that
   * carries it arrives later, after the payload is built.
   */
  | { type: 'AGENT_OBSERVED'; elements: number; sensitive: number }
  | { type: 'AGENT_PAGE'; origin: string; title: string }
  | { type: 'AGENT_DETECTION'; counts: DetectionCounts }
  | { type: 'AGENT_REDACTION'; counts: RedactionCounts; fields: RedactedField[] }
  | { type: 'AGENT_OUTBOUND'; summary: OutboundSummary }
  | { type: 'AGENT_CONFIRM_REQUIRED'; request: GrantRequest }
  /**
   * `target` is the handle the action named — a ref for a sealed field, an
   * element id otherwise. Without it the record says an effect ran but not
   * what it ran on, and anything reading the record has to guess.
   */
  | { type: 'AGENT_ACTION_RESOLVED'; effect: string; outcome: 'executed' | 'refused'; reason?: string; target?: string }
  | { type: 'AGENT_ERROR'; message: string }
  /**
   * A canary reached the serialised outbound body. The request was aborted
   * and the session is stopped: no retry, no degraded continue.
   *
   * `escapedKinds` names what got out. Never the values — that would leak the
   * tracer into the panel and the event log to report that it leaked.
   */
  | { type: 'AGENT_BLOCKED'; title: string; detail: string; planted: number; escaped: number; escapedKinds: string[] }
  /**
   * What the planner sent back, before the gate has had a say. Carried
   * separately from AGENT_ACTION_RESOLVED because the two answer different
   * questions: this is what was *proposed*, that is what was *allowed*. Seeing
   * a proposal that never ran is the whole point of showing it.
   */
  | { type: 'AGENT_PLAN'; status: string; message: string; action: unknown; stubbed: boolean }
  | { type: 'AGENT_MANIFEST'; entries: ManifestLine[] };

/**
 * The envelope every emitted event carries.
 *
 * `seq` is monotonic for the worker's lifetime. The worker replays its
 * history whenever a panel reconnects, so the panel dedupes on `seq` — that
 * is what stops a replay double-counting the counters. `replay` marks those
 * repeats so the panel can render them without entry animation, and `at` is
 * stamped once at emit time so a replayed event still shows when it really
 * happened rather than when it was replayed.
 */
export type AgentEventMessage = AgentEventBody & {
  at?: string;
  seq?: number;
  replay?: boolean;
};

/** One readable line of the egress manifest. Never carries a value. */
export interface ManifestLine {
  at: string;
  kind: 'egress' | 'action' | 'canary';
  digest?: string;
  destination?: string;
  fieldsSent?: number;
  refsSent?: number;
  redactionCount?: number;
  effect?: string;
  outcome?: 'executed' | 'refused';
  reason?: string;
  /** Canary lines only. Counts and kinds — never the tracer values. */
  canariesPlanted?: number;
  canariesEscaped?: number;
  escapedKinds?: string[];
}

/** Sent by the side panel to the service worker. */
export type PanelCommand =
  | { type: 'PANEL_READY' }
  | { type: 'PANEL_CONFIRM'; decision: 'authorise' | 'refuse' };
