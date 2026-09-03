import React, { useState, useEffect, useRef } from 'react';
import { ExtensionMessage } from '../shared/messaging';

interface LogEntry {
  ts: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  message: string;
}

const STATUS_COLOR: Record<string, string> = {
  running: '#38bdf8',
  completed: '#4ade80',
  error: '#f87171',
  idle: '#94a3b8',
};

const BADGE_BG: Record<string, string> = {
  running: '#0284c7',
  completed: '#16a34a',
  error: '#dc2626',
  idle: '#334155',
};

export const App: React.FC = () => {
  const [goal, setGoal] = useState('');
  const [status, setStatus] = useState<'idle' | 'running' | 'completed' | 'error'>('idle');
  const [log, setLog] = useState<LogEntry[]>([{ ts: now(), status: 'idle', message: 'Agent ready.' }]);
  const [backendUrl, setBackendUrl] = useState('http://127.0.0.1:8000');
  const [showSettings, setShowSettings] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Load persisted backend URL
  useEffect(() => {
    chrome.storage.local.get('backendUrl', (res) => {
      if (res.backendUrl) setBackendUrl(res.backendUrl);
    });
  }, []);

  // Scroll to bottom of log on new entries
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log]);

  // Listen for status updates from service worker
  useEffect(() => {
    const handleMessage = (message: ExtensionMessage) => {
      if (message.type === 'TASK_STATUS') {
        setStatus(message.status);
        setLog((prev) => [...prev, { ts: now(), status: message.status, message: message.message }]);
      }
    };
    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, []);

  const handleStart = () => {
    if (!goal.trim()) return;
    setStatus('running');
    setLog([{ ts: now(), status: 'running', message: `Goal: ${goal}` }]);
    chrome.runtime.sendMessage({ type: 'START_TASK', goal });
  };

  const handleStop = () => {
    chrome.runtime.sendMessage({ type: 'STOP_TASK' });
    setStatus('idle');
    setLog((prev) => [...prev, { ts: now(), status: 'idle', message: 'Stopped by user.' }]);
  };

  const saveBackendUrl = () => {
    chrome.storage.local.set({ backendUrl });
    setShowSettings(false);
  };

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={styles.logo}>CLIO</span>
          <span style={styles.version}>v0.1</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ ...styles.badge, backgroundColor: BADGE_BG[status] }}>
            {status.toUpperCase()}
          </span>
          <button onClick={() => setShowSettings((s) => !s)} style={styles.iconBtn} title="Settings">
            Settings
          </button>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div style={styles.settingsPanel}>
          <label style={styles.label}>Backend URL</label>
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              value={backendUrl}
              onChange={(e) => setBackendUrl(e.target.value)}
              style={{ ...styles.input, flex: 1 }}
              placeholder="http://127.0.0.1:8000"
            />
            <button onClick={saveBackendUrl} style={styles.saveBtn}>Save</button>
          </div>
        </div>
      )}

      {/* Goal input */}
      <textarea
        rows={3}
        placeholder="Describe your goal (e.g. 'Log in to GitHub with email user@example.com')"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        disabled={status === 'running'}
        onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey) handleStart(); }}
        style={styles.textarea}
      />

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: '8px' }}>
        {status !== 'running' ? (
          <button
            onClick={handleStart}
            disabled={!goal.trim()}
            style={{ ...styles.btn, backgroundColor: goal.trim() ? '#0284c7' : '#334155', cursor: goal.trim() ? 'pointer' : 'not-allowed' }}
          >
            Run Agent
          </button>
        ) : (
          <button onClick={handleStop} style={{ ...styles.btn, backgroundColor: '#dc2626' }}>
            Stop
          </button>
        )}
        <button
          onClick={() => setLog([{ ts: now(), status: 'idle', message: 'Log cleared.' }])}
          style={{ ...styles.btn, backgroundColor: '#1e293b', border: '1px solid #334155', flex: '0 0 auto', padding: '6px 10px' }}
          title="Clear log"
        >
          Clear
        </button>
      </div>

      {/* Scrollable action log */}
      <div style={styles.logContainer}>
        {log.map((entry, i) => (
          <div key={i} style={styles.logEntry}>
            <span style={styles.logTs}>{entry.ts}</span>
            <span style={{ color: STATUS_COLOR[entry.status], fontSize: '11px', flex: 1 }}>
              {entry.message}
            </span>
          </div>
        ))}
        <div ref={logEndRef} />
      </div>

      {/* Footer hint */}
      <div style={styles.hint}>Ctrl+Enter to run · {log.length} events</div>
    </div>
  );
};

function now() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: '340px',
    backgroundColor: '#0f172a',
    color: '#f8fafc',
    fontFamily: "'Inter', system-ui, sans-serif",
    padding: '14px',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    minHeight: '300px',
    maxHeight: '560px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  logo: { fontSize: '15px', fontWeight: 700, color: '#38bdf8' },
  version: { fontSize: '10px', color: '#475569', fontWeight: 500 },
  badge: {
    fontSize: '10px',
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: '999px',
    letterSpacing: '0.05em',
  },
  iconBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: '14px',
    padding: '2px',
    lineHeight: 1,
  },
  settingsPanel: {
    backgroundColor: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '6px',
    padding: '10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  label: { fontSize: '11px', color: '#94a3b8' },
  input: {
    backgroundColor: '#0f172a',
    color: '#f8fafc',
    border: '1px solid #475569',
    borderRadius: '4px',
    padding: '5px 8px',
    fontSize: '12px',
    outline: 'none',
  },
  saveBtn: {
    backgroundColor: '#0284c7',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    padding: '5px 10px',
    fontSize: '12px',
    cursor: 'pointer',
  },
  textarea: {
    width: '100%',
    boxSizing: 'border-box' as const,
    backgroundColor: '#1e293b',
    color: '#f8fafc',
    border: '1px solid #475569',
    borderRadius: '6px',
    padding: '8px',
    fontSize: '13px',
    resize: 'none' as const,
    outline: 'none',
    fontFamily: 'inherit',
    lineHeight: 1.5,
  },
  btn: {
    flex: 1,
    padding: '8px',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    fontWeight: 600,
    fontSize: '13px',
  },
  logContainer: {
    backgroundColor: '#1e293b',
    borderRadius: '6px',
    border: '1px solid #1e3a5f',
    padding: '8px',
    flex: 1,
    overflowY: 'auto' as const,
    minHeight: '120px',
    maxHeight: '220px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  logEntry: {
    display: 'flex',
    gap: '6px',
    alignItems: 'flex-start',
    lineHeight: 1.4,
  },
  logTs: {
    fontSize: '10px',
    color: '#475569',
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
  },
  hint: {
    fontSize: '10px',
    color: '#334155',
    textAlign: 'center' as const,
  },
};