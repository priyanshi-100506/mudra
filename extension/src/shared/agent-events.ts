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

export interface RedactionCounts {
  textReferences: number;
  maskedRegions: number;
  reOcrVerified: boolean;
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
}

export type AgentPhase =
  | 'IDLE' | 'CAPTURING' | 'DETECTING' | 'REDACTING' | 'BUILDING_SCENE'
  | 'PLANNING' | 'AWAITING_CONFIRMATION' | 'EXECUTING'
  | 'COMPLETE' | 'REFUSED' | 'ERROR';

/** Emitted by the service worker; consumed by the side panel only. */
export type AgentEventMessage =
  | { type: 'AGENT_PHASE'; phase: AgentPhase }
  | { type: 'AGENT_PAGE'; origin: string; title: string }
  | { type: 'AGENT_DETECTION'; counts: DetectionCounts }
  | { type: 'AGENT_REDACTION'; counts: RedactionCounts }
  | { type: 'AGENT_OUTBOUND'; summary: OutboundSummary }
  | { type: 'AGENT_CONFIRM_REQUIRED'; request: GrantRequest }
  | { type: 'AGENT_ACTION_RESOLVED'; effect: string; outcome: 'executed' | 'refused'; reason?: string }
  | { type: 'AGENT_ERROR'; message: string };

/** Sent by the side panel to the service worker. */
export type PanelCommand =
  | { type: 'PANEL_READY' }
  | { type: 'PANEL_CONFIRM'; decision: 'authorise' | 'refuse' };
