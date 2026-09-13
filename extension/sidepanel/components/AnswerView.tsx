import React, { useEffect, useRef, useState } from 'react';
import type { AgentState } from '../types';
import { sendChat } from '../bridge';
import { Lockup } from './Lockup';

interface Turn { role: 'you' | 'mudra'; text: string }

/**
 * The answer view: what the run means, in prose, plus somewhere to ask.
 *
 * The panel's feed and the planner sheet are both machine records — verbs,
 * refs, JSON. This is the same run described in words, which is what someone
 * actually asks for when they say "what happened".
 *
 * The context sent alongside a question is built from what this view was
 * already shown: labels, refs, effects. None of it has ever held a value, so
 * asking a question cannot become the way one escapes the device.
 */
function buildContext(state: AgentState): string {
  const parts: string[] = [];
  if (state.observed) {
    parts.push(`Observed ${state.observed.elements} fields; sealed ${state.observed.sensitive}.`);
  }
  const sealed = state.fields.filter((f) => f.sensitive);
  if (sealed.length) {
    parts.push(`Sealed: ${sealed.map((f) => `${f.label} (${f.ref})`).join(', ')}.`);
  }
  const visible = state.fields.filter((f) => !f.sensitive);
  if (visible.length) {
    parts.push(`Left visible: ${visible.map((f) => f.label).join(', ')}.`);
  }
  for (const a of [...state.audit].reverse()) {
    parts.push(`${a.effect} ${a.outcome}${a.reason ? ` — ${a.reason}` : ''}.`);
  }
  if (state.outbound) {
    parts.push(`${state.outbound.piiValuesSent} values and ${state.outbound.rawPixelsSent} raw pixels left the device.`);
  }
  return parts.join(' ');
}

export const AnswerView: React.FC<{ state: AgentState; onBack: () => void }> = ({
  state, onBack,
}) => {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const thread = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = thread.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, busy]);

  const ask = async (question: string) => {
    if (!question || busy) return;
    setDraft('');
    setError(null);
    setTurns((t) => [...t, { role: 'you', text: question }]);
    setBusy(true);
    try {
      const reply = await sendChat(question, buildContext(state));
      setTurns((t) => [...t, { role: 'mudra', text: reply }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // The opening answer is asked for automatically, so the view has something
  // to say the moment it opens rather than an empty box.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void ask('In two or three sentences, what did you just do on this page?');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="lp">
      <header className="lp-head">
        <button className="lp-back" onClick={onBack} aria-label="Back to activity">←</button>
        <Lockup variant="dark" height={26} className="lp-lockup" />
        <span className="lp-answer-tag">Answer</span>
      </header>

      <div className="lp-thread" ref={thread}>
        {turns.map((t, i) => (
          <div key={i} className={`lp-turn is-${t.role}`}>
            <span className="lp-turn-who">{t.role === 'you' ? 'You' : 'Mudra'}</span>
            <p className="lp-turn-text">{t.text}</p>
          </div>
        ))}
        {busy && <p className="lp-thinking">Thinking…</p>}
        {error && <p className="lp-thread-err">{error}</p>}
      </div>

      <footer className="lp-ask">
        <textarea
          className="lp-ask-input"
          value={draft}
          rows={2}
          placeholder="Ask about this run…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(draft.trim()); }
          }}
        />
        <button className="lp-btn" onClick={() => void ask(draft.trim())}
          disabled={busy || !draft.trim()}>Send</button>
      </footer>
    </div>
  );
};
