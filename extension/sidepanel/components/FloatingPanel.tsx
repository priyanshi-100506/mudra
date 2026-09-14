import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExtensionShell } from '../ExtensionShell';

const W = 400;
const H = 600;
const MARGIN = 16;

/**
 * The panel, floating over the page it is watching.
 *
 * The popup and the side panel both take the user's eyes off the page at the
 * moment the page is the thing worth looking at — the seals land there. Here
 * the same panel sits beside them, so the overlay on the page and the feed
 * describing it are in one field of view.
 *
 * Dragged by its own bar rather than the panel header, so dragging can never
 * be confused with pressing something inside the panel.
 */
export const FloatingPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [pos, setPos] = useState(() => ({
    x: Math.max(MARGIN, window.innerWidth - W - MARGIN),
    y: MARGIN,
  }));
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  const onDown = (e: React.MouseEvent) => {
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    e.preventDefault();
  };

  const clamp = useCallback((x: number, y: number) => ({
    // Never let it be dragged somewhere it cannot be dragged back from.
    x: Math.min(Math.max(x, -W + 80), window.innerWidth - 80),
    y: Math.min(Math.max(y, 0), window.innerHeight - 40),
  }), []);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!drag.current) return;
      setPos(clamp(e.clientX - drag.current.dx, e.clientY - drag.current.dy));
    };
    const up = () => { drag.current = null; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    const resize = () => setPos((p) => clamp(p.x, p.y));
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('resize', resize);
    };
  }, [clamp]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  return (
    <div
      className="mf"
      style={{ left: pos.x, top: pos.y, width: W, height: H }}
      role="dialog"
      aria-label="Mudra"
    >
      <div className="mf-grip" onMouseDown={onDown}>
        <span className="mf-grip-dots" aria-hidden="true" />
        <button className="mf-close" onClick={onClose} aria-label="Close Mudra">×</button>
      </div>
      <div className="mf-body">
        <ExtensionShell floating />
      </div>
    </div>
  );
};
