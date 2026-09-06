# MUDRA

**On-device visual perception for light-weight browser agents.**
Smart India Hackathon 2026 · Problem Statement `SIH26171` · ISRO, Department of Space

---

Browser agents must see the page to act on it. Today, seeing means uploading —
the password, the PAN, the photograph, all of it shipped to a cloud model. For
banks, hospitals and government offices this makes agentic automation
undeployable.

MUDRA keeps perception on the machine. Sensitive values become opaque
references the planner can reason about but never read, and every
side-effecting action is mediated against a transaction grant the user
authorised for that task, on that document, before the plan existed.

```
extension/  npm install && npm run build   → load extension/dist unpacked
backend/    uvicorn app.main:app --reload --port 8000
```

---

## Design

```
                    USER'S DEVICE — trust boundary
   ┌────────────────────────────────────────────────────────────┐
   │  capture ──▶ detect ──▶ redact ──▶ scene graph             │
   │  visible     rules      text→ref    bbox · role · name     │
   │  tab+DOM     faces      px→mask     state · masked regions │
   │              NER·OCR                                       │
   │                                                            │
   │  ┌──────────────────────────────────────────────────────┐  │
   │  │  ACTION EXECUTOR            the security boundary     │  │
   │  │  resolve handle → revalidate identity, origin, role   │  │
   │  │  → check against grant → execute · confirm · REFUSE   │  │
   │  └──────────────────────────────────────────────────────┘  │
   │                                                            │
   │  egress manifest — what left, what was masked, what was    │
   │  refused                                                   │
   └────────────────────────────────────────────────────────────┘
        │  refs + scene graph                ▲  six verbs
        │  no values, no raw pixels          │  opaque handles only
        ▼                                    │
   ┌────────────────────────────────────────────────────────────┐
   │  SERVER — FastAPI, near-stateless, ASSUMED COMPROMISED     │
   │  validate (reject raw PII, strict schema) → plan           │
   │  manifest store · audit endpoints · viewer                 │
   └────────────────────────────────────────────────────────────┘
```

The server is never trusted to be honest. It is confined to six verbs and to
the data flows the user pre-authorised for this task. Everything it does
server-side is defence in depth, never the boundary.

### Three primitives

| | Is | Is not |
|---|---|---|
| **Reference** | a request-scoped random handle standing in for a value; safe to hand an untrusted server | authority to *use* the value; not a predictable string like `PASSWORD_1` |
| **Grant** | a local, task- and document-scoped policy declaring allowed flows, effects and expiry | mintable or broadenable by the server; survives navigation, target replacement or origin change |
| **Secret** | the value itself, resolved only inside the executor at the moment of execution | ever present in a payload, a log, or the manifest |

### The command schema

The planner may emit exactly six verbs. No JavaScript, no selectors, no raw
URLs cross back.

```
click_handle · set_public_text · set_secret_ref
scroll · navigate_allowed_url · request_commit
```

`set_secret_ref` names two references — a source and a target. The planner
directs a credential into a field without ever learning either value. The
`ActionVerifier` accepts these blind fills: an action carrying no raw input is
valid by design, not incomplete.

---

## The wire contract

The extension sends a redacted scene graph. There is no `value` field on the
type — not empty, not null, absent.

```json
{
  "ref": "ref_1k4z",
  "role": "textbox",
  "name": "Login Password",
  "input_type": "password",
  "autocomplete": "current-password",
  "sensitive": true,
  "bbox": { "x": 40, "y": 220, "width": 280, "height": 36 }
}
```

For ordinary elements `ref` is the stable element id. For sensitive ones it is
a request-scoped random handle that means nothing outside this request.

Server-side models use `extra="forbid"`. If a future client bug reintroduces a
`value` field, the request fails loudly with a 422 rather than quietly
accepting and logging a secret.

---

## Repository

```
extension/
├── src/
│   ├── content/
│   │   ├── perception.ts        DOM + a11y tree walk, handle registration
│   │   ├── node-registry.ts     opaque handles, document epoch, revalidation
│   │   ├── redaction.ts         value-level PII detection, reference interning
│   │   ├── executor.ts          resolves handles, performs actions, refuses
│   │   └── highlight.ts         on-page seal overlay (shadow DOM)
│   ├── background/
│   │   ├── service-worker.ts    agent loop, the action gate, egress
│   │   ├── manifest.ts          client-side egress manifest
│   │   ├── panel-events.ts      UI event emitters + state replay
│   │   └── planner-stub.ts      scripted hostile planner (demo only)
│   ├── shared/
│   │   ├── types.ts             PageIR, PageElement, AgentAction
│   │   ├── agent-events.ts      SceneElement, RedactedField, event union
│   │   ├── redact.ts            field-level sensitivity, buildOutbound
│   │   └── grant.ts             grant derivation, checkAction
│   └── popup/                   extension UI
├── fixtures/                    adversarial pages
├── sample.html                  8 PII categories, local test bench
└── tests/

backend/
├── app/
│   ├── schemas/manifest.py      EgressManifestEntry
│   ├── manifest_store.py        in-memory audit engine
│   ├── verifier.py              ActionVerifier
│   └── agent_loop.py            step(), auto-records to the manifest
└── tests/

docs/                            blueprint, handover, threat model,
                                 TESTING_GUIDE.md
```

---

## Invariants

Five properties the code enforces. Breaking any one breaks the claim.

**No value crosses the boundary.** `buildOutbound()` serialises the payload,
scans it for every protected value, and throws if one survives. The worker
converts that throw into a refusal rather than sending. The `values sent: 0`
counter is backed by that assertion, not by intention.

```ts
for (const { value } of r.refMap.values()) {
  if (value && serialised.includes(value)) {
    throw new Error('Redaction failed: a protected value reached the outbound payload.');
  }
}
```

**Every side-effecting action is mediated.** `checkAction()` runs before
execution. Missing grant, origin change, unlisted effect or exhausted uses all
refuse. The default branch refuses — fail closed.

**Targets are node identity, not selectors.** Selectors are page-controlled and
rebindable between the moment the plan is made and the moment it runs. The
registry hands out opaque handles backed by `WeakRef`, keyed by a per-document
epoch, and revalidates identity, connectedness, origin and role immediately
before execution.

**A refusal is bounded, not fatal.** The executor refuses, logs, and continues
with the remaining steps. The user's task completes; the attacker's does not.
Three refusals in one run stops it.

**Every egress is recorded.** `AgentLoop.step` writes an `EgressManifestEntry`
on each round trip: payload digest, fields described, references sent,
redaction count, destination, timestamp, and the action outcome. Entries carry
no values, by construction of what they digest.

---

## Egress manifest

The audit artefact. A compliance reviewer reads it without a walkthrough.

```
POST /manifest/record        record an entry
GET  /manifests              list
GET  /manifests/{id}         one entry
GET  /manifests/viewer/html  live visual audit
```

Deliberately a plain log, not a hash chain. A chain implies tamper-evidence
guarantees that would require an untampered extension and complete coverage of
every request — neither of which we can prove in four weeks. A plain log gives
the same "see what left" evidence without an unsupportable claim.

---

## Running it

```bash
# extension
cd extension
npm install
npm run build          # tsc --noEmit → vite → vite (content, IIFE) → manifest
npm test               # 60 vitest

# backend
cd backend
uvicorn app.main:app --reload --port 8000
pytest                 # 40 tests
```

Load `extension/dist` via `chrome://extensions` → Load unpacked. Reload from
that page after every build; content scripts do not update in already-open
tabs without a page reload. `manifest.json` declares `file://*/*` so local
fixtures work — enable **Allow access to file URLs** in the extension details.

Full procedure in `docs/TESTING_GUIDE.md`.

### Demonstrating the refusal

The demo can run without a backend. A scripted planner stands in — and it is
scripted to be **hostile**: it reads the injected instruction on the fixture
page and complies with it. The point is that the executor refuses anyway.

```js
// service worker console
chrome.storage.local.set({ plannerStub: true })
```

Open `extension/fixtures/bank-login.html` and run "log me in". Expected,
reading the manifest bottom to top:

```
set_public_text         EXECUTED
set_public_text         EXECUTED
navigate_cross_origin   REFUSED    "navigate_cross_origin" is not among the
                                   effects authorised for this task.
click                   EXECUTED
```

Everything after the stub — grant derivation, the gate, the refusal, the
manifest entry — is the real code path.

### Build notes

`tsconfig.json` sets `noEmit`. A bare `tsc` writes `.js` beside every source
file and Vite resolves those in preference to the TypeScript, silently running
stale code. The build script sweeps them first.

Content scripts run as classic scripts and cannot import chunks, hence the
second Vite pass emitting a single IIFE.

`backdrop-filter` does nothing in an extension popup — there is no page behind
it to sample.

---

## Branches

| Branch | Purpose |
|---|---|
| `main` | production |
| `backend/mudra-support` | schema alignment — `ref`/`sensitive`/`bbox`/`autocomplete`, blind-fill verification, 31 alignment tests |
| `backend/manifest-viewer` | egress audit — schema, store, REST endpoints, `AgentLoop.step` hook, HTML viewer |
| `integration/extension-manifest` | merges manifest backend with the extension UI; resolves `redact.ts`; unskips canvas rasterization tests |
| `feature/mudra-complete-testing` | end-to-end bench: 8 PII categories in `sample.html`, `file://` permissions, testing guide |

---

## Status

**Working.** Local detection and redaction with resolved accessible names.
Identity-first sensitivity — an empty card-number field is sensitive for what
it is, not what it holds. Layer 1 rules: password inputs, autocomplete tokens,
PAN, Aadhaar + Verhoeff, card + Luhn, IFSC, UPI VPA, passport. The redaction
reel and on-page seal overlay. Grants, the action gate, live refusal with
continuation. Opaque handles with epoch and pre-execution revalidation. Egress
manifest end to end, client through server, with a viewer.

**Not done.**

- The confirmation dialog has never rendered from a real trigger — wired and
  inspected, not exercised end to end.
- Detection is Layer 1 only. Faces, NER and OCR report `0`.
- `300 MB` and `3 s` are **targets, not measurements**. Nobody has run the
  profiler on a mid-range laptop. They are labelled as targets, not results.

**Scoped out, deliberately.** Two to three task templates on a defined page
set. CAPTCHAs. Arbitrary websites. We do not claim arbitrary planner output is
safe in general — only that it is confined to pre-authorised actions and data
flows for this task, on this document.

### A finding worth recording

The selector-rebinding attack is **not reachable in the current loop**. The
agent re-observes before every action, leaving no window between observation
and execution for a page to swap a target into. The handle registry defends
async gaps, navigation and role drift — not this. The fixture is kept because
the property should hold if the loop ever changes, and because a defence you
cannot currently trigger is worth stating rather than claiming.

---

## Prior art

Object capabilities and the Principle of Least Authority (Miller, Yee &
Shapiro) · Macaroons — contextual caveats (Google) · WebAuthn origin binding ·
CaMeL, Task Shield, Progent · CWE-367 (TOCTOU) · OWASP Top 10 for LLM
Applications.

The primitive is old. The contribution is applying request-scoped, document-
and task-bound grants to browser-agent action execution with an opaque-handle
executor. An engineering integration, not a new theory.
