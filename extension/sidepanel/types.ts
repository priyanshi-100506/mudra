export type {
  AgentPhase, DetectionCounts, RedactionCounts,
  OutboundSummary, GrantRequest as PendingAction,
} from '../src/shared/agent-events';

export interface PageContextInfo { origin: string; title: string }

export interface AuditEntry {
  at: string;
  effect: string;
  outcome: 'executed' | 'refused';
  reason?: string;
}

import type {
  AgentPhase, DetectionCounts, RedactionCounts, OutboundSummary, GrantRequest,
} from '../src/shared/agent-events';

export interface AgentState {
  phase: AgentPhase;
  page: PageContextInfo | null;
  task: string | null;
  detection: DetectionCounts | null;
  redaction: RedactionCounts | null;
  outbound: OutboundSummary | null;
  pending: GrantRequest | null;
  audit: AuditEntry[];
  error: string | null;
}
