import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FloatingPanel } from '../../sidepanel/components/FloatingPanel';
import themeCss from '../../sidepanel/theme.css?inline';
import panelCss from '../../sidepanel/live-panel.css?inline';
import floatingCss from '../../sidepanel/floating.css?inline';

const HOST_ID = 'mudra-overlay-host';
let root: Root | null = null;
let host: HTMLElement | null = null;

export function closeMudra() {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
}

export function openMudra() {
  if (host) return;
  host = document.createElement('div');
  host.id = HOST_ID;
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  // `:root` never matches inside a shadow root, so the theme's tokens would
  // resolve to nothing and every colour would fall back. Rehoming them onto
  // the host is what makes the panel look identical in the page and in the
  // popup, from one stylesheet.
  style.textContent = [
    themeCss.replace(/:root/g, ':host'),
    panelCss,
    floatingCss,
  ].join('\n');
  shadow.appendChild(style);

  const mount = document.createElement('div');
  shadow.appendChild(mount);
  root = createRoot(mount);
  root.render(<FloatingPanel onClose={closeMudra} />);
}

export function toggleMudra() {
  host ? closeMudra() : openMudra();
}
