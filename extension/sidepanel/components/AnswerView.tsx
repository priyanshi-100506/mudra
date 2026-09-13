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
export function buildContext(state: AgentState): string {
  // Written as a labelled record, not prose. The first version listed fields
  // that were "left visible" next to a list of effects with no targets, and
  // the model joined the two — reporting that it had filled in fields it had
  // never touched. Each list now says exactly what it is, and the actions
  // name the handle they acted on, so there is nothing left to infer.
  const lines: string[] = [];

  lines.push('=== RECORD OF THIS RUN (authoritative; nothing outside it happened) ===');

  if (state.observed) {
    lines.push(`Fields observed on the page: ${state.observed.elements}`);
    lines.push(`Fields sealed before sending: ${state.observed.sensitive}`);
  }

  const sealed = state.fields.filter((f) => f.sensitive);
  lines.push(sealed.length
    ? `SEALED FIELDS (value never left the device; only the reference was sent): ${
        sealed.map((f) => `${f.label} = ${f.ref}`).join('; ')}`
    : 'SEALED FIELDS: none');

  const visible = state.fields.filter((f) => !f.sensitive);
  lines.push(visible.length
    ? `FIELDS DESCRIBED BUT NOT ACTED ON (merely visible to the planner, NOT filled in): ${
        visible.map((f) => f.label).join('; ')}`
    : 'FIELDS DESCRIBED BUT NOT ACTED ON: none');

  const done = [...state.audit].reverse().filter((a) => a.outcome === 'executed');
  lines.push(done.length
    ? `ACTIONS EXECUTED (this is the complete list): ${
        done.map((a) => `${a.effect}${a.target ? ` on ${a.target}` : ''}`).join('; ')}`
    : 'ACTIONS EXECUTED: none. Nothing was changed on the page.');

  const refused = [...state.audit].reverse().filter((a) => a.outcome === 'refused');
  lines.push(refused.length
    ? `ACTIONS REFUSED BY THE GATE (proposed but blocked, did NOT happen): ${
        refused.map((a) => `${a.effect}${a.target ? ` on ${a.target}` : ''} — ${a.reason ?? 'refused'}`).join('; ')}`
    : 'ACTIONS REFUSED: none');

  if (state.outbound) {
    lines.push(`Values sent off the device: ${state.outbound.piiValuesSent}. Raw pixels sent: ${state.outbound.rawPixelsSent}.`);
  }
  return lines.join('\n');
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
