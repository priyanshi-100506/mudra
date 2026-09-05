export type AgentPhase =
  | 'IDLE' | 'CAPTURING' | 'DETECTING' | 'REDACTING' | 'BUILDING_SCENE'
  | 'PLANNING' | 'AWAITING_CONFIRMATION' | 'EXECUTING'
  | 'COMPLETE' | 'REFUSED' | 'ERROR';

export interface PageContextInfo { origin: string; title: string }
export interface DetectionCounts { structuredPii: number; faces: number; namedEntities: number; ocrRegions: number }
export interface RedactionCounts { textReferences: number; maskedRegions: number; reOcrVerified: boolean }

/** Safe outbound view. Never carries a resolved value. */
export interface OutboundSummary {
  rawPixelsSent: 0;
  piiValuesSent: 0;
  fieldsDescribed: number;
  preview: string;
}

export interface PendingAction {
  sentence: string; origin: string; effect: string;
  targetRole: string; targetRef: string;
}

export interface AuditEntry {
  at: string; effect: string;
  outcome: 'executed' | 'refused'; reason?: string;
}

export interface AgentState {
  phase: AgentPhase;
  page: PageContextInfo | null;
  task: string | null;
  detection: DetectionCounts | null;
  redaction: RedactionCounts | null;
  outbound: OutboundSummary | null;
  pending: PendingAction | null;
  audit: AuditEntry[];
  error: string | null;
}
