import React from 'react';
import type { IconName } from '../types';

/**
 * The six feed icons.
 *
 * All 24x24, stroke-only, round caps and joins, no fill — so a single
 * `stroke` colour drives every one of them and the chip decides the hue.
 *
 * These are authored here rather than copied from the reference wireframe,
 * which was not supplied with the spec. They match the six roles it names:
 * eye (observed), seal (sealed), up (sent), check (executed / informational),
 * stop (refused), log (manifest).
 */
const PATHS: Record<IconName, React.ReactNode> = {
  eye: (
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  seal: (
    <>
      <rect x="4" y="10.5" width="16" height="10" rx="2" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
      <path d="M12 14.5v2.5" />
    </>
  ),
  up: (
    <>
      <path d="M12 20V5" />
      <path d="M5.5 11.5 12 5l6.5 6.5" />
    </>
  ),
  check: <path d="M4.5 12.5 9.5 17.5 19.5 7" />,
  stop: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8 8l8 8" />
    </>
  ),
  log: (
    <>
      <path d="M5 4.5h14v15H5z" />
      <path d="M8.5 9h7M8.5 12.5h7M8.5 16h4" />
    </>
  ),
};

export const Icon: React.FC<{ name: IconName; size?: number; className?: string }> = ({
  name, size = 12, className,
}) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {PATHS[name]}
  </svg>
);

/** The header mark: the kolam motif reduced to a single glyph. */
export const MarkIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#fff"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3.5 20.5 12 12 20.5 3.5 12z" />
    <path d="M12 8.5 15.5 12 12 15.5 8.5 12z" />
  </svg>
);
