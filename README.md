# MUDRA (SIH26171)
**On-Device Visual Perception and Privacy-Preserving Execution for Autonomous Browser Agents**  
*ISRO / Department of Space · Smart Automation*

---

## 1. Overview
MUDRA provides a client-side perception and execution boundary for autonomous web agents. Current web agent architectures require transmitting raw screen captures, DOM values, and sensitive user credentials to cloud-hosted models. MUDRA moves perception, entity detection, value redaction, and action policy enforcement entirely onto the client device.

All sensitive inputs are obfuscated into request-scoped opaque reference tokens (`ref_*`). The backend agent operates statelessly on an anonymous scene graph and returns high-level actions within a closed six-verb specification. Client-side grant policies enforce action boundaries before execution.

---

## 2. Architecture & System Flow

```
+-------------------------------------------------------------------+
|                        CLIENT BOUNDARY                            |
| 1. Perception Walker   : Extracts interactive DOM & bounding boxes|
| 2. Detection Engine    : Identifies PII (PAN, Aadhaar, Cards, etc)|
| 3. Redaction Pipeline  : Replaces plaintext with opaque refs      |
| 4. Grant Enforcement   : Enforces document- & task-scoped policy  |
| 5. Action Executor     : Resolves refs & executes approved actions|
+---------------------------------+---------------------------------+
                                  |
            Opaque Scene Graph    | Closed 6-Verb Actions
            (Zero Raw PII)        | (Opaque Handles)
                                  v
+-------------------------------------------------------------------+
|                        STATELESS BACKEND                          |
| 6. Agent Planner (Gemini): Evaluates scene graph & plans action   |
| 7. Egress Audit Manifest : Logs execution history & grant status  |
+-------------------------------------------------------------------+
```

---

## 3. Core Technical Specifications

### Client-Side Detection & Redaction
- **Identity-First Detection**: Flags sensitive inputs by structural metadata (`input_type`, `autocomplete`, field names) prior to content insertion.
- **Rule-Based Algorithmic Validation**:
  - Aadhaar detection integrated with Verhoeff checksum validation algorithm.
  - Payment Cards verified via Luhn algorithm validation.
  - Indian Tax (PAN), Banking (IFSC, UPI VPA), Passport (IN), SSN, and Email regex verification.
- **Request-Scoped Reference Isolation**: Maps plaintext PII to unique opaque tokens (`ref_*`). Raw values are isolated in client memory and excluded from serialised network payloads.

### Grant Enforcement & Action Spec
- Actions restricted to a closed 6-verb set: `click`, `type`, `select`, `scroll`, `navigate`, `wait`.
- High-impact operations (`submit_form`, cross-origin navigation, credential insertion) require active policy grants. Unauthorized operations fail closed and emit audit events.

### Egress Audit Manifest
- Real-time audit endpoint (`GET /manifests`) and visual viewer (`GET /manifests/viewer/html`) logging outbound payload metadata, redacted token counts, and policy verdicts without exposing plaintext values.

---

## 4. Repository Structure

```
.
├── backend/
│   ├── app/
│   │   ├── agent/            # Gemini client, loop, & action verifier
│   │   ├── schemas/          # PageIR, AgentAction, & Manifest schemas
│   │   ├── manifest_store.py # In-memory egress audit store
│   │   └── main.py           # FastAPI entrypoint & manifest routes
├── extension/
│   ├── src/
│   │   ├── content/          # Perception walker & redaction logic
│   │   ├── background/       # Service worker & grant coordinator
│   │   └── shared/           # Types, redact utilities, & grant rules
├── tests/
│   ├── backend/              # PyTest suite for schemas & endpoints
│   └── extension/            # Vitest suite for redaction & safety
```

---

## 5. Verification & Testing

### Backend Test Suite
```bash
cd backend
.venv\Scripts\python.exe -m pytest ..\tests\backend
```
- 40/40 tests passing (Schema validation, Mudra contract alignment, Egress Audit Manifest endpoints).

### Extension Test Suite
```bash
cd extension
npm test
```
- 60/60 tests passing (Redaction safety, Verhoeff/Luhn validation, Canvas rasterization, DOM walker).

---

## 6. Choosing a planner

`PLANNER` selects which brain answers. Set it in `backend/.env`.

| Value | What answers | Needs |
|---|---|---|
| `gemini` | hosted planner (default) | `GEMINI_API_KEY`, a network |
| `ollama` | a local vision-language model on this machine | Ollama running locally |
| `stub` | deterministic plans, no model at all | nothing |

`GET /health` reports which one is live, and the side panel shows it too.
That is deliberate: *"the plans got worse"* and *"the backend silently
changed"* are different problems — one is the model, one is the configuration
— and they must not look alike when you have two minutes to work it out.

`stub` is never the default and has to be asked for by name. A stub running by
default would serve canned plans that look like a working agent, and nobody
would notice until someone asked it to do something the canned plan did not
cover.

### Running fully offline

```bash
ollama pull qwen2.5vl:3b
OLLAMA_ORIGINS='chrome-extension://*' ollama serve
```

> ### ⚠️ `OLLAMA_ORIGINS` is not optional
>
> Ollama's CORS allowlist contains no extension origin by default, so **every
> request from the extension comes back 403**.
>
> The failure is quiet in the worst possible way: the backend is up, the model
> is loaded, `ollama list` looks right — and local inference never runs once.
> If you start Ollama any other way, the offline demo will appear to work and
> will not be doing anything.
>
> ```bash
> OLLAMA_ORIGINS='chrome-extension://*' ollama serve
> ```

Then set `PLANNER=ollama` in `backend/.env`. The redacted screenshot is sent
to the local model as an image, so it can reason about layout the DOM does not
describe — without ever seeing a face or an identity number.

---

## 7. Development Setup

### Backend Setup

**macOS / Linux**
```bash
cd backend
python3 -m venv ../.venv
source ../.venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

**Windows (PowerShell)**
```powershell
cd backend
python -m venv ..\.venv
..\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

### Extension Setup
```bash
cd extension
npm install
npm run build
```

### Evaluation

```bash
cd extension && npm run eval
```

Writes `eval/results.json`. Ground truth and results are both committed — see
[`eval/README.md`](eval/README.md) for the measured numbers and their
conditions.
Load the unpacked extension directory (`extension/dist`) into Chrome via `chrome://extensions`.
