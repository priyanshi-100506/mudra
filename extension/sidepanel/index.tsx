import React from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';
import { ExtensionShell } from './ExtensionShell';

const el = document.getElementById('root');
if (el) createRoot(el).render(<React.StrictMode><ExtensionShell /></React.StrictMode>);
