# CLIO Architecture

CLIO (**C**lient-**L**ocal **I**ntelligent **O**rchestrator) is a browser-automation system consisting of three decoupled layers that communicate over two well-defined boundaries.

---

## Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (Chrome)                                               │
│                                                                 │
│  ┌──────────────┐    chrome.runtime    ┌──────────────────────┐ │
│  │  Popup / UI  │◄────────────────────►│  Service Worker      │ │
│  │  (React TSX) │  messages            │  (background.ts)     │ │
│  └──────────────┘                      │                      │ │
│                                        │  • manages session   │ │
│  ┌──────────────┐  chrome.tabs.msg     │  • calls /agent/step │ │
│  │ Content Script│◄───────────────────►│  • drives exec loop  │ │
│  │ perception.ts │  CAPTURE_PAGE_IR    │                      │ │
│  │ executor.ts   │  EXECUTE_ACTION     └──────────┬───────────┘ │
│  └──────────────┘                                 │             │
│                                                   │ fetch (HTTP)│
└───────────────────────────────────────────────────┼─────────────┘
                                                    │
                              ┌─────────────────────▼──────────────┐
                              │  Backend  (FastAPI / Python)        │
                              │                                     │
                              │  POST /agent/step                   │
                              │    └─ AgentLoop.step()              │
                              │         ├─ ActionVerifier.verify()  │
                              │         └─ GeminiAgentClient        │
                              │              └─ Gemini API          │
                              │                                     │
                              │  POST /agent/reset                  │
                              │  GET  /agent/status/:id             │
                              │  GET  /health                       │
                              └─────────────────────────────────────┘
```

---

## Layers in Detail

### Layer 1 — Content Script (`extension/src/content/`)

Runs in the page's document context. Responsible for:

- **`perception.ts`** — `capturePageIR()` walks the DOM, resolves accessible names, and builds a `PageIR` snapshot. Sensitive fields are hoisted to the front of the candidate list before the 60-element cap is applied.
- **`executor.ts`** — Receives `EXECUTE_ACTION` messages from the service worker and performs DOM side effects (click, value-set, select, scroll, navigate).
- **`highlight.ts`** — Draws the Mudra redaction overlay (blue outlines → black seal for sensitive fields) inside a shadow root.

### Layer 2 — Service Worker (`extension/src/background/service-worker.ts`)

The orchestration hub. Runs persistently (Manifest V3 service worker):

1. Receives `START_TASK` from the popup; generates a `session_id` UUID.
2. Injects the content script and sends `CAPTURE_PAGE_IR`.
3. Receives `PAGE_IR_CAPTURED` with the raw `PageIR`.
4. Runs the **Mudra redaction pipeline** (`redact.ts`):
   - Detects sensitive fields (`isSensitive`).
   - Replaces their `id` with a random `ref_` handle; strips `value`.
   - Calls `buildOutbound()` which **throws** if any protected value survived serialisation.
5. POSTs the redacted payload to `POST /agent/step`.
6. Receives an `AgentAction`; checks it through `checkAction()` (grant gate).
7. Sends `EXECUTE_ACTION` to the content script.
8. Waits for DOM to settle; loops back to step 2.

State machine phases:
```
IDLE → CAPTURING → DETECTING → REDACTING → BUILDING_SCENE
     → PLANNING → AWAITING_CONFIRMATION → EXECUTING → COMPLETE
```
Terminal from any phase: `REFUSED`, `ERROR`.

### Layer 3 — Backend (`backend/app/`)

A stateless FastAPI service. Each `session_id` maps to an `AgentLoop` instance held in memory.

- **`AgentLoop.step()`** — validates `element_id` references, calls the Gemini client, records history (capped at 10 steps for prompt efficiency), runs `ActionVerifier` on the previous step's outcome.
- **`GeminiAgentClient`** — builds the prompt JSON, calls `gemini-flash-lite-latest` (with `gemini-2.5-flash` fallback), parses and validates the raw JSON response into an `AgentAction`.
- **`ActionVerifier`** — post-hoc sanity check comparing before/after PageIR snapshots to detect silently-failed actions.

---

## Data Flow — One Agent Step

```
Popup: "Fill the login form"
    │
    ▼ chrome.runtime.sendMessage START_TASK
Service Worker
    │ chrome.tabs.sendMessage CAPTURE_PAGE_IR
    ▼
Content Script → capturePageIR() → PageIR{id, value, ...}
    │ chrome.runtime.sendMessage PAGE_IR_CAPTURED
    ▼
Service Worker → redactPageIR()  → SceneElement{ref, sensitive}  (value stripped)
              → buildOutbound()  → throws if any value survived
    │ fetch POST /agent/step {goal, session_id, page_ir: redacted}
    ▼
Backend → AgentLoop.step()
        → GeminiAgentClient.plan_next_action()
        → Gemini API → {"action":"type","element_id":"e1","text":"alice"}
    │ 200 LoopStepResponse{action, status:"continue", message}
    ▼
Service Worker → checkAction() → allow / confirm / refuse
              → chrome.tabs.sendMessage EXECUTE_ACTION
    ▼
Content Script → executor sets input value, clicks button, etc.
    │ Loop back to CAPTURE_PAGE_IR
    ▼
  ... (next step)
```

---

## Key Design Principles

| Principle | Implementation |
|---|---|
| **Local-first redaction** | Values never leave the device; the backend only sees opaque `ref_` handles for sensitive fields |
| **Fail closed** | `buildOutbound()` throws on any value leak; the grant gate refuses anything unmatched |
| **Deterministic schema** | All cross-boundary shapes are Pydantic-validated (backend) and TypeScript-typed (extension) |
| **Stateless backend** | Session state is in-memory only; a server restart requires the extension to call `/agent/reset` |
| **Graceful degradation** | Gemini quota exhaustion falls back to a `done` action rather than crashing |

---

## Directory Structure

```
clio/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI app, endpoints
│   │   ├── config.py            # Settings (GEMINI_API_KEY, HOST, PORT)
│   │   ├── agent/
│   │   │   ├── loop.py          # AgentLoop — orchestrates steps, verifies actions
│   │   │   ├── gemini_client.py # Gemini API wrapper, system prompt, action parsing
│   │   │   └── verifier.py      # Post-hoc action outcome verification
│   │   └── schemas/
│   │       ├── page_ir.py       # PageIR, PageElement, BoundingBox Pydantic models
│   │       └── actions.py       # All AgentAction variants, discriminated union
│   └── requirements.txt
├── extension/
│   └── src/
│       ├── background/
│       │   └── service-worker.ts  # Orchestration hub
│       ├── content/
│       │   ├── perception.ts      # DOM → PageIR
│       │   ├── executor.ts        # AgentAction → DOM side effects
│       │   └── highlight.ts       # Redaction overlay
│       ├── popup/                 # React UI
│       └── shared/
│           ├── types.ts           # PageIR / AgentAction TypeScript types
│           ├── redact.ts          # Mudra redaction pipeline
│           ├── grant.ts           # Local authority / action gate
│           ├── messaging.ts       # chrome.runtime message types
│           └── agent-events.ts    # Panel event types
├── docs/
│   ├── api.md                 # Endpoint reference
│   ├── page_ir_spec.md        # PageIR wire spec
│   ├── action_schema.md       # AgentAction types
│   └── architecture.md        # This file
├── tests/
│   ├── backend/               # pytest suite
│   └── e2e/                   # FastAPI TestClient integration tests
└── README.md
```
