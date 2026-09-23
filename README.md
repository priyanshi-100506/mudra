# MUDRA

**On-device visual perception for light-weight browser agents**
SIH 2026 · **SIH26171** · ISRO / Department of Space

> <!-- NARRATIVE: one or two sentences. What MUDRA is, in plain language,
>      for someone who has read nothing else. Kavya + team to write. -->

<!-- HERO GIF: demo showing a page with a face, a scanned Aadhaar and a
     password field → the split view → "0 canaries escaped". -->

---

## The problem

<!-- NARRATIVE: thin on purpose. The factual frame is below; the argument
     around it is yours to write. -->

Browser agents work by sending the page to a model. In practice that means a
screenshot and the DOM — including the password field, the Aadhaar number on
the KYC page, and whoever is on the video call in the next tab.

MUDRA moves perception onto the device. The planner receives a description of
the page rather than the page.

---

## Before and after

The same bank login page, as a conventional agent sends it and as MUDRA sends
it.

**Conventional agent — 1.9 MB screenshot plus DOM values:**

```json
{
  "screenshot": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg…",   // ~1.9 MB
  "url": "https://bank.example.in/login?token=a83f#session",
  "elements": [
    { "id": "e1", "name": "Customer ID",    "value": "CUST88214" },
    { "id": "e2", "name": "Login Password", "value": "hunter2" },
    { "id": "e3", "name": "PAN",            "value": "BKPPS4321N" }
  ]
}
```

**MUDRA — real output from `buildOutbound()`:**

```json
{
  "url": "https://bank.example.in/login?token=%5Bredacted%5D&next=%2Fhome",
  "title": "Net Banking — Meera Iyer",
  "elements": [
    { "ref": "e1", "role": "textbox", "name": "Customer ID",
      "input_type": null, "sensitive": false, "bbox": null },
    { "ref": "ref_el05upusgd", "role": "textbox", "name": "Login Password",
      "input_type": "password", "sensitive": true, "bbox": null },
    { "ref": "ref_el05upcajc", "role": "textbox", "name": "PAN",
      "input_type": null, "sensitive": true, "bbox": null }
  ],
  "text_snippets": ["Welcome back, Meera"],
  "observed_at": "2026-01-01T09:14:00Z"
}
```

The planner can still tell there is a password field and a PAN field, and can
still act on them by reference. `hunter2` and `BKPPS4321N` are not present in
any form — the outbound type has no `value` field for them to occupy.

<!-- NARRATIVE: the payload-size line goes here once measured end to end with
     the ONNX weights in place. The panel computes it for real; do not quote a
     ratio that has not been measured. -->

---

## Never leaves the device

Derived from the code, not aspirational.

| | Where it lives |
|---|---|
| **Raw screenshot** | offscreen document only; `close()`d after the pass |
| **Field values** (`PageElement.value`) | content script → service worker |
| **The `ref_* → value` map** | service worker memory; consulted only after the grant gate approves |
| **OCR text from images** | offscreen document; classified, then discarded |
| **Canary tokens** | minted per observation, never serialised |
| **URL fragment** | dropped outright |
| **Query params with sensitive keys** | replaced with `[redacted]` |
| **Face bounding boxes → pixels** | painted black before anything is sent |

## May be sent

| | Why |
|---|---|
| Element **role**, **name**, **input type** | the planner must know a password box is a password box |
| Opaque **`ref_*` handles** | so it can act without knowing values |
| A **`sensitive`** flag | so it can plan around protected fields |
| **Bounding boxes** (CSS px) | layout reasoning |
| **Sanitised URL and title** | context |
| **Sanitised text snippets** | context |
| **A redacted screenshot** | *only* when re-OCR verification passed |
| **Counts** — identifiers found, faces, masked regions | telemetry |
| **SHA-256 of the sent body**, and of the image | the audit manifest |

---

## Measured results

From [`eval/results.json`](eval/results.json), committed and reproducible with
`cd extension && npm run eval`.

**Conditions:** Apple M3, 8 cores, 8 GB RAM, macOS (Darwin 25.5.0 arm64),
Node v24.2.0, Chrome 153. 19 fixtures, 30 synthetic identifiers, 16 decoys.

| Metric | Result |
|---|---|
| Recall (text pipeline) | **100%** (25/25) |
| Precision | **89.3%** |
| F1 | **94.3%** |
| **Decoy false positives** | **3 / 15 (20.0%)** |
| Leaks after redaction | **0** |
| Canaries escaped | **0** of 3 per observation |
| Local pipeline p50 / p95 | **7.4 ms / 61.5 ms** |
| Payload per observation p50 / p95 | **602 B / 1257 B** |
| Peak heap | **98.1 MB** |

### Status and limits

<!-- NARRATIVE: tone is yours, but these facts should survive the edit. -->

- **Six of eighteen fixtures have not been run.** They need the UltraFace-320
  weights, which are not yet committed. Their rows read `not-run`, never zero,
  and the recall figure above is scoped to the text pipeline rather than
  presented as a whole-system number.
- **The three false positives are all one cause: PAN and IFSC have no
  checksum.** Where a checksum exists — Aadhaar, card — every decoy is
  correctly ignored, including a GSTIN that contains a valid PAN as a
  substring. Where none exists, MUDRA over-seals on purpose: a sealed SKU
  costs the planner one unreadable field, an unsealed PAN is the failure this
  project exists to prevent.
- **Names are sealed by field label, not by recognition.** A `Full name` or
  `Name as on Aadhaar` field is sealed, and that value is then scrubbed from
  the page title and text too. But a name appearing *only* in prose, never in
  a labelled field, is not detected — there is no NER, and `namedEntities` is
  reported as an honest `0` rather than a plausible number.
- **Five identifiers sit in prose the perception layer does not collect.**
  Reported as `notObserved` rather than counted as successes.
- The end-to-end visual path has not yet been exercised against the real
  model.

---

## How it works

Three documents, written from the code:

| | |
|---|---|
| [**docs/architecture.md**](docs/architecture.md) | the pipeline end to end, the trust boundary, what runs where, and every fail-closed path |
| [**docs/page_ir_spec.md**](docs/page_ir_spec.md) | the Page IR shape, the `ref_*` contract, what may and may not be sent |
| [**docs/action_schema.md**](docs/action_schema.md) | the verbs, validation, and what the grant system permits and refuses |

### The two ideas worth knowing

**Re-OCR verification.** After the masks are painted, the redacted image is
read back with the same OCR engine and checked: no value seen this observation
is still readable, and nothing newly readable passes `isPII`. A correct-looking
mask list and a correctly masked image are different claims, and only the
second one matters. Failure means the image is not sent.

**Canary tokens.** Three fake-but-valid identifiers are planted in the DOM
before the page is read and in the OCR stream, travel the same code as real
values, and are searched for in the *serialised* request body immediately
before it is sent. A hit aborts the request and stops the session with a named
state in the panel. The panel reports: `Canary tokens: 3 planted, 0 escaped`.

---

## Quick start

```bash
make demo
```

Brings up the backend, builds the extension and serves the fixtures. Then load
`extension/dist` as an unpacked extension at `chrome://extensions`.

See [Development setup](#development-setup) for the step-by-step version,
and [Choosing a planner](#choosing-a-planner) for running fully offline.

---

## Repository

| | |
|---|---|
| `extension/src/content/` | perception, the single PII detector, the executor |
| `extension/src/offscreen/` | face detection, OCR, redaction, re-OCR verification |
| `extension/src/background/` | the observation loop, grant gate, canary gate, manifest |
| `extension/sidepanel/` | the UI, including "What the AI sees" |
| `backend/app/` | FastAPI, planner switch, PII tripwire, egress manifest |
| `eval/` | 18 fixtures, ground truth, harness, committed results |
| `docs/` | architecture, Page IR spec, action schema |

---

## Choosing a planner

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

## Development setup

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
