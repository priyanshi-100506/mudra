import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MudraOverlay } from '../../sidepanel/MudraOverlay';
import overlayCss from '../../sidepanel/overlay.css?inline';

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
  style.textContent = overlayCss;
  shadow.appendChild(style);
  const mount = document.createElement('div');
  shadow.appendChild(mount);
  root = createRoot(mount);
  root.render(<MudraOverlay onClose={closeMudra} />);
}

export function toggleMudra() {
  host ? closeMudra() : openMudra();
}
