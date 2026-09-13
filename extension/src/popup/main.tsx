import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../sidepanel/theme.css';
import '../../sidepanel/live-panel.css';
import { ExtensionShell } from '../../sidepanel/ExtensionShell';

// The popup and the side panel render the same panel. Chrome caps a popup at
// 600px tall, so the feed simply has less room to scroll in; every zone, and
// every event behind it, is identical.
const el = document.getElementById('root');
if (el) createRoot(el).render(<React.StrictMode><ExtensionShell /></React.StrictMode>);
