# CLIO — Client-Local Intelligent Orchestrator

> **SIH26171 · Team Mudra**
> A privacy-first browser automation agent. Sensitive values never leave the device.

---

## What is CLIO?

CLIO is a browser extension + backend system that lets an AI agent complete web tasks on your behalf. Unlike conventional browser agents, CLIO uses **local redaction**: all sensitive field values (passwords, card numbers, Aadhaar, PAN, OTPs…) are stripped from the page snapshot *before* it is sent to the backend. The agent plans actions using only labels and roles — it never sees your secrets.

**Architecture in one sentence:** The extension captures the page → redacts sensitive values → sends a clean snapshot to the FastAPI backend → Gemini plans the next action → the extension executes it.

---

## Privacy Model

```
Browser                                   Backend (server)
───────────────────────────────           ─────────────────────
DOM value: "hunter2"                      ref: "ref_1k4z"  ← opaque handle
                ↓ redact.ts strips value  sensitive: true  ← flag only
                                          (no value field)
```

- `buildOutbound()` in the extension **throws** if any protected value survives serialisation. The service worker converts that throw into a task refusal.
- The backend only ever receives already-redacted snapshots. It must not attempt to dereference `ref_` handles.

---

## Quick Start

### Prerequisites

- Python 3.11+
- Node 20+ (for the extension)
- A [Google Gemini API key](https://aistudio.google.com/app/apikey)

### Backend

```bash
cd backend

# Create virtual environment
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS/Linux

pip install -r requirements.txt

# Set API key
echo GEMINI_API_KEY=your_key_here > .env

# Start server
uvicorn app.main:app --reload
# → http://127.0.0.1:8000
```

### Extension

```bash
cd extension
npm install
npm run build          # compiles TypeScript → dist/
```

Load in Chrome:
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `extension/dist/`

### Run Tests

```bash
# From repo root, with venv activated
cd backend
python -m pytest ../tests/ -v
```

---

## Project Structure

```
clio/
├── backend/          # FastAPI agent backend
├── extension/        # Chrome extension (TypeScript)
├── docs/             # API reference, specs, architecture
├── tests/
│   ├── backend/      # Unit + integration tests (pytest)
│   └── e2e/          # End-to-end tests
└── README.md
```

Full details in [`docs/architecture.md`](docs/architecture.md).

---

## API Overview

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness probe |
| `POST` | `/agent/step` | Plan next action from PageIR |
| `POST` | `/agent/reset` | Clear session state |
| `GET` | `/agent/status/:id` | Session metadata |
| `GET` | `/test` | Built-in HTML test page |

Full reference in [`docs/api.md`](docs/api.md).

---

## What the Agent Can Do

| Action | Description |
|---|---|
| `click` | Click an element |
| `type` | Type text into an input |
| `select` | Choose a dropdown option |
| `scroll` | Scroll the page |
| `navigate` | Go to a URL |
| `wait` | Pause for page load / animation |
| `extract` | Read text from an element |
| `done` | Signal task completion |

Full schema in [`docs/action_schema.md`](docs/action_schema.md).

---

## Local Redaction — Detailed Rules

The extension detects sensitive fields by **what they are**, not only what they hold. An empty credit card input is still treated as sensitive.

**Signals checked (in order):**
1. `input_type` — `password`, `tel`
2. `autocomplete` attribute — any `cc-*`, `current-password`, `new-password`, `one-time-code`, `bday`, `tel-national` token
3. Resolved label — matched against a combined pattern covering PAN, Aadhaar, CVV, OTP, IFSC, UPI, passport, licence, SSN, date-of-birth, and more
4. Current value — PAN regex, Aadhaar + Verhoeff check digit, card number + Luhn check, IFSC, UPI VPA, Indian passport pattern

**Layer 1 coverage (this PR):**

| Type | Detection |
|---|---|
| Password | `input_type=password` |
| PAN | Regex + label |
| Aadhaar | Regex + Verhoeff check digit |
| Credit/Debit card | Regex + Luhn check |
| IFSC code | Regex + label |
| UPI VPA | `user@provider` pattern |
| OTP | Label |
| Email | Label / `input_type=email` |
| Indian passport | `[A-Z][0-9]{7}` + label |

Faces, NER, and OCR (Layer 2) are tracked as zero in the current counters and will be added in a future release.

---

## Known Limitations

- **Confirmation dialog** — the component exists and is wired, but no real plan returns from the backend yet to trigger it during a live session.
- **Canvas pixel pipeline** — three canvas tests are skipped pending Playwright (jsdom cannot rasterize).
- **Backend session state is in-memory** — restarting the server loses active sessions.

---

## Branches

| Branch | Purpose |
|---|---|
| `main` | Stable production code |
| `backend/mudra-support` | Backend tests, docs, and README (this branch) |
| `mudra-extension-ui` | Frontend/extension work (PR #1) |

---

## License

MIT
