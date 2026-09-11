import React from 'react';
import { Card, Section, SecondaryButton } from './primitives';

export const ErrorState: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => (
  <Card>
    <h2 className="h2">Something went wrong</h2>
    <Section><p className="sub" style={{ margin: 0 }}>{message}</p></Section>
    <div style={{ marginTop: 12 }}>
      <SecondaryButton onClick={onRetry}>Start over</SecondaryButton>
    </div>
  </Card>
);
