import React from 'react';
import { createRoot } from 'react-dom/client';
import './popup.css';
import './tune.css';
import { MudraPopup } from './MudraPopup';

const el = document.getElementById('root');
if (el) createRoot(el).render(<React.StrictMode><MudraPopup /></React.StrictMode>);
