import React from 'react';
import { Card, StatusPill } from './primitives';
import { PHASE_LABEL, isBusy } from '../state';
import type { AgentPhase } from '../types';

const tone = (p: AgentPhase) =>
  p === 'COMPLETE' ? 'ok'
  : p === 'AWAITING_CONFIRMATION' ? 'warn'
  : p === 'REFUSED' || p === 'ERROR' ? 'stop'
  : 'neutral';

export const AgentStatus: React.FC<{ phase: AgentPhase; task: string | null }> = ({ phase, task }) => (
  <Card>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <StatusPill tone={tone(phase)} live={isBusy(phase)}>{PHASE_LABEL[phase]}</StatusPill>
      <p className="sub" aria-live="polite">
        {task ? `Task: ${task}` : 'Describe what you want done on this page.'}
      </p>
    </div>
  </Card>
);
