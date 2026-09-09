import React from 'react';

/**
 * The MUDRA lockup.
 *
 * Two variants ship: the stock lockup for light grounds, and a recoloured one
 * whose counters match a #0F172A ground. The kolam's inner shapes are painted,
 * not transparent, so the light lockup turns into solid blobs on a dark
 * surface — pick the variant that matches the surface, not the theme name.
 *
 * The file is resolved through `chrome.runtime.getURL` because the in-page
 * overlay runs on the host page, where a relative path would resolve against
 * the site rather than the extension. It is declared in
 * `web_accessible_resources` so that lookup is permitted.
 */
export const Lockup: React.FC<{
  variant?: 'light' | 'dark';
  height?: number;
  className?: string;
}> = ({ variant = 'light', height = 34, className }) => {
  const file = variant === 'dark' ? 'mudra-lockup-dark.svg' : 'mudra-lockup.svg';
  const src =
    typeof chrome !== 'undefined' && chrome.runtime?.getURL
      ? chrome.runtime.getURL(`src/assets/${file}`)
      : `src/assets/${file}`;

  return (
    <img
      src={src}
      alt="Mudra"
      className={className}
      height={height}
      style={{ height, width: 'auto', display: 'block', flex: 'none' }}
    />
  );
};
