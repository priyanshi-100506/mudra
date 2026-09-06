# MUDRA — Project Blueprint

**SIH26171 · On-device Visual Perception for Light-weight Browser Agents**  
ISRO, Department of Space · Software · Smart Automation · 6 people · 4 weeks

---

## 1. The thing itself

AI browser agents have to see your screen to fill a form. Today, seeing means
uploading — your password, your PAN, your photo, all of it goes to somebody
else's cloud model. So banks, hospitals and government offices cannot deploy
agents at all.

MUDRA moves the perception onto the machine. Sensitive values become
references the server can talk about but never read, and every action the
agent takes has to fall inside a transaction the user authorised for that
task, on that page. Nothing sensitive leaves the device, and the task still
completes.

**The claim that has to survive cross-examination:** we do not claim arbitrary
planner output is safe in general. We claim it is confined to a small set of
pre-authorised actions and data flows for this task, on this document —
anything else is refused and logged.

---

## 2. Three concepts everyone must know cold

| | What it is | What it does NOT do |
|---|---|---|
| **Reference** | A random handle standing in for a sensitive value. Safe to hand an untrusted server. Lets the planner *discuss* a value: "put the credential in the password field." | Does not authorise *using* the value. Not a predictable string like `PASSWORD_1` — predictable ids collide with attacker-controlled page text. |
| **Grant** | A small local policy derived at task start, confirmed by the user for high-impact work. Declares the allowed data flow, the allowed effects, the expiry conditions. | Cannot be minted or broadened by the server. Expires on navigation, target replacement, origin change. Has `max_uses`. |
| **Secret** | The actual value. Resolved only inside the action executor, at the moment of execution. | Never leaves the client. Not in a payload, not in a log, not in the manifest. |

Nearly every hard judge question is answered by pointing at the right row.

---

## 3. Architecture

```
              USER'S DEVICE  (trust boundary)
  ┌──────────────────────────────────────────────────┐
  │  1 CAPTURE      visible tab + DOM snapshot       │
  │  2 DETECT       rules · faces · NER · OCR        │
  │  3 REDACT       text → refs · pixels → masks     │
  │  4 SCENE GRAPH  bbox · role · name · state       │
  │  5 GRANT        derived at task start            │
  │                                                  │
  │  9 ACTION EXECUTOR  ← the real security boundary │
  │     resolve handle → revalidate identity,        │
  │     frame/origin, role → check against grant →   │
  │     execute · confirm · REFUSE                   │
  │                                                  │
  │  10 EGRESS MANIFEST  what left, what was refused │
  └──────────────────────────────────────────────────┘
        ↓ refs + scene graph          ↑ six verbs,
          no values, no pixels          opaque handles only
  ┌──────────────────────────────────────────────────┐
  │  SERVER — FastAPI, near-stateless,               │
  │  ASSUMED POSSIBLY COMPROMISED                    │
  │  7 VALIDATE   reject raw PII, strict schema      │
  │  8 PLAN       six-verb closed enum               │
  └──────────────────────────────────────────────────┘
```

The server is never trusted to be honest. It is confined to six verbs and to
the data flows the user pre-authorised for this task.

### The six verbs

`click_handle` · `set_public_text` · `set_secret_ref` · `scroll` ·
`navigate_allowed_url` · `request_commit`

No JavaScript, no selectors, no raw URLs ever cross back. `set_secret_ref` is
the interesting one: the planner says "put the credential in the password
field" by naming two refs, and never learns either value.

---

## 4. Scoring — where the marks actually are

| Weight | Criterion | Target | Owner |
|---|---|---|---|
| 25% | Visual context accuracy | ≥95% field/role identification | Detection + ML |
| 20% | PII recall & precision | recall ≥0.95 structured, precision ≥0.90 | Detection |
| 20% | Redaction precision | zero leaks incl. pixel level, no over-mask | Detection + Eval |
| 20% | Client resource use | <300 MB peak, models <40 MB, mid-range laptop | ML |
| 15% | End-to-end latency | <3 s typical, <500 ms local-only | ML + Backend |

**Over 40% of the score is measurable, which means it can be lost by nobody
having measured it.** The biggest single risk is visual-context accuracy at
25% — a DOM skeleton alone is not visual context, which is why the design
sends an allowlisted scene graph with bounding boxes, roles, states and OCR
coordinates.

---

## 5. Six modules, six owners

| Role | Owns | One-line stake |
|---|---|---|
| **Presenter & Eval Lead** | corpus, adversarial harness, metrics, deck, demo, the clock | owns whether the work is believed |
| **Frontend / Extension** | extension shell, agent loop, confirmation UI, payload panel | owns what the judge sees |
| **Security & Executor** | handle registry, grant derivation, action executor, refusal, manifest | **owns the differentiator** |
| **Detection & Redaction** | DOM+OCR extraction, PII rule engine, pixel-mask pipeline | owns 40% of the score |
| **ML / On-device** | MediaPipe, ONNX quantisation, WASM runtime, every latency and memory number | owns the numbers |
| **Backend & Integration** | FastAPI planning endpoint, wire schema, rejection validator, CI | deliberately the smallest surface |

**The one rule:** every member owns one slice end to end and must be able to
explain any section of the design. Judges deliberately question the quietest
person in the room. A team where only the presenter can explain the
architecture loses to a weaker project where all six can.

---

## 6. Where the build actually stands

### Working, demonstrated

- **Local detection and redaction.** Accessible-name resolution (aria-label,
  aria-labelledby, `<label for>`, wrapping label, table cells, sibling walk).
  Identity-first detection — an empty Credit Card Number field is sensitive
  for what it *is*, not what it holds. Layer 1 rules: password inputs,
  autocomplete tokens, PAN, Aadhaar + Verhoeff, card + Luhn, IFSC, UPI VPA,
  Indian passport.
- **The `VALUES 0` counter is load-bearing, not decorative.**
  `buildOutbound()` serialises the payload, scans it for every protected
  value, and throws if one survives; the worker converts that throw into a
  refusal rather than sending. A test asserts the throw fires.
- **The redaction reel.** Field labels strike through one at a time, each
  replaced by a blue `ref_`, with a hard rule beneath reading "leaves the
  device". An on-page overlay mirrors it: scan line, field outlines, then
  solid black seals with `ref_` tags.
- **Grants and the action gate.** Derived locally at task start from three
  templates. Missing grant, origin change, unlisted effect or exhausted uses
  all refuse and log. Fail closed.
- **The refusal, live.** An adversarial fixture carries a hidden injected
  instruction; a deliberately hostile planner stub complies with it; the
  executor refuses the cross-origin navigate, logs the reason, and **carries
  on with the remaining steps**. The user's task completes; the attacker's
  does not.
- **Opaque node handles** with a document epoch and pre-execution
  revalidation of identity, connectedness, origin and role.
- **Backend contract aligned with Mudra frontend.** `PageElement` schema on
  the backend now accepts `ref`, `sensitive: bool`, `autocomplete`, and `bbox`
  with zero `value` fields required. The ActionVerifier accepts blind fills
  unconditionally and lets subsequent observations verify state changes.
  All 36 backend tests and 57 extension tests pass cleanly.

### Known gaps, stated honestly

- **The confirmation dialog has never rendered from a real trigger.** The
  phase, the event and the component all exist and are wired; nothing has
  fired it outside code inspection.
- **Detection is Layer 1 only.** Faces, NER and OCR report 0. Some fields
  (SSN and others) still read SAFE.
- **The rebinding attack is not reachable in the current loop.** The agent
  re-observes before every action, so no window exists between observation and
  execution for a page to swap a target into. The handle registry defends
  async gaps, navigation and role drift — not this. Say so rather than rigging
  a fixture until it produces a refusal.
- **The epoch is scoped to the document, not the observation.** Rotating per
  observation invalidated the handles the current plan was built against.
  Narrower than the design implies; belongs in the threat model as an open
  question.
- **300 MB and 3 s are targets, not measurements.** Nobody has run the
  profiler on a mid-range laptop. Label them as targets on the slide until
  someone has.
- **Three canvas tests are skipped** — jsdom stubs canvas and does not
  rasterize. The pixel pipeline is a real security property and needs
  verifying in a browser.

---

## 7. Four-week plan

| | Week 1 D1–7 | Week 2 D8–14 | Week 3 D15–21 | Week 4 D22–28 |
|---|---|---|---|---|
| Frontend | cross-browser shell · capture · agent loop | | confirmation UI | polish · payload panel |
| Security | handle registry · schema | epoch binding · executor | grants · refusal logic | adversarial hardening |
| Detection | | India PII rules · masking | OCR · non-DOM regions | threshold tuning |
| ML | instrumentation | | MediaPipe · gated NER | resource opt · WebGPU if stable |
| Backend | FastAPI round trip | validator · planner · CI | | manifest viewer |
| Presenter | labelled corpus starts | adversarial harness · metrics · deck | | rehearsal ×10 |

**Exit gates.** W1: one round trip in Chrome AND Firefox. W2: zero leaks, text
and pixel, on the corpus. W3: task completes; injection refused by executor.
W4: every metric has a number.

**Feature freeze is day 24.** The last four days are rehearsal, bug-fixing and
recording numbers. The Presenter enforces this and does not negotiate.

**Fallback.** A DOM-and-scene-graph-only build — rules, references, grants,
executor, manifest — is still a complete, demonstrable system without the
vision-heavy pixel pipeline. Reachable by day 14, loses points only on
visual-context accuracy. Decide by day 18. Do not decide on day 26.

---

## 8. Demo — six beats, about four minutes

| # | Beat | What judges see | What you say |
|---|---|---|---|
| 1 | The problem, live | A form with a password field, PAN and a photo | "An agent has to see all of this to fill this form." |
| 2 | Redaction appears | Detection runs on-device; face masked; fields become refs inline | "That all just happened on this laptop. Nothing has left yet." |
| 3 | Split screen | Page left, outbound payload right, counter reading raw pixels sent: 0 | "This is everything the server is about to receive. Look for a single real value." |
| 4 | Task completes | Agent fills and submits; the server never saw a value | "Privacy did not cost us the capability." |
| 5 | Pull the network | Wi-Fi off; the local-only path still completes low-risk steps | "The perception is genuinely local. Here is the proof, not the claim." |
| 6 | **The refusal** | Injected page pushes a high-impact action outside the grant. Executor refuses. Close on the manifest entry. | "We don't claim arbitrary planner output is safe in general. We claim it's confined to pre-authorised actions and data flows for this task, on this document — anything else is refused and logged." |

Beat 6 is the one that survives scrutiny. The original version showed a secret
typed into the wrong field, which demonstrates only the narrowest attack.
Showing a refused high-impact action demonstrates the actual boundary.

Rehearsed until boring. Ten clean run-throughs, on the machine you will
actually use, on a network you do not trust.

---

## 9. Risk register

| Risk | Mitigation |
|---|---|
| WebGPU unavailable or slow | Not a release gate. WASM is the baseline. |
| spaCy cannot run in the browser | Designed around from day 1 — spaCy offline for corpus building, quantised ONNX at runtime. |
| PII missed → leak | Layered detection, server-side pattern rejection, and a re-OCR check on the final encoded image before egress. |
| Compromised planner causes harm without touching a seal | The executor plus the grant is the boundary, not the seal typechecker. |
| Selector targeting unsafe | Opaque handle registry from week 1, not a later hardening pass. |
| Scope creep into "any website" | Explicitly scoped to 2–3 task templates on a defined page set. |
| Team drifts to comfortable backend work | The server is deliberately near-stateless. Effort is budgeted to the client. |
| Team unfamiliar with extensions and security | One-week curve, front-loaded into days 1–7. |

---

## 10. Judge Q&A

**"Isn't this just capability systems?"** Yes, the primitive is old — object
capabilities, Macaroons, WebAuthn origin binding. Our contribution is applying
request-scoped, document- and task-bound grants to browser-agent action
execution with an opaque-handle executor. An engineering integration, not a
new theory.

**"What stops a compromised server from clicking Submit on an already-filled
form?"** If submission is not in the current grant's allowed effects, the
executor refuses and logs it. If it is — a login task legitimately ending in a
submit — that is the one effect the user already authorised for this task,
once, on this document.

**"Why solid masks instead of blur?"** Blur and pixelation can be reversed or
leak information. Solid masks with margin, redrawn on a re-encoded canvas, do
not.

**"Is a DOM skeleton really visual context?"** No, and that is why we do not
send one. We send an allowlisted scene graph with bounding boxes, roles,
states, masked regions and OCR coordinates.

**"What if the user clicks through the confirmation?"** Then the damage is
bounded to one effect, one document, one use, and it appears in the manifest.
Confirmation is a layer, not the only layer.

**"How did you measure this, and on what hardware?"** Have the laptop spec on
a slide.

**"What is your biggest weakness?"** Answer instantly: coverage breadth. We
are scoped to 2–3 task templates. Extending coverage is the first roadmap item
and the architecture does not need to change to do it.

**"Is that mocked?"** For the planner in the demo, yes — it is scripted so the
refusal can be shown without a backend, and it is scripted to be *hostile*.
Everything after it — grant, gate, refusal, manifest — is the real code path.

---

## 11. The two things that decide this

**Scope honestly.** Say the limit out loud before you are asked. The single
most damaging thing anyone on this team can say to a judge is "the attack is
impossible." Every honest limitation buys credibility for everything else.

**Hold the gates.** The hardest thing in a four-week hackathon is not the code
— it is keeping six people pointed at the 40% of the score that is measurable
while the interesting problems pull them elsewhere. Hold the exit gates. Hold
the day-24 freeze. And make sure the quietest person on the team can draw the
architecture, because that is the one judges will ask.
