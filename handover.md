# MUDRA / CLIO Handover

This document is for the frontend collaborator preparing the operation and Gemini integration video.

## Branches and what to use

- `mudra-extension-ui`: frontend branch. Contains the extension UI, popup/side panel, content-script perception, local redaction, action execution, grants, confirmation dialog, and frontend tests.
- `backend/mudra-support`: backend foundation branch. Contains the FastAPI app, Gemini client/agent loop, schemas, verifier, and backend alignment work.
- `integration/mudra-full-pipeline`: final runnable/demo branch. Use this branch for the video. It contains the merged frontend plus the completed backend integration, automatic egress-manifest recording, manifest API, and HTML audit viewer.
- `main`: documentation/baseline branch. This handover is here so it is easy to find. Do not use `main` as the demo checkout unless the full-pipeline commits have been merged into it.

Recommended checkout for the demo:

```powershell
git fetch origin
git checkout integration/mudra-full-pipeline
git pull --ff-only origin integration/mudra-full-pipeline
```

## What has been built

MUDRA is a browser-agent privacy boundary. The browser extension observes the page and keeps plaintext values locally. It sends the backend an anonymous Page IR in which sensitive values are represented by request-scoped `ref_*` handles. Gemini plans one action at a time from that Page IR. The extension checks the action against a local task/origin grant before executing it in the page.

The main flow is:

1. The content script captures visible interactive DOM elements and assigns temporary element IDs.
2. The extension detects sensitive values locally. Aadhaar and payment cards use Verhoeff/Luhn validation; other supported values use structural patterns.
3. The redaction layer replaces detected plaintext with opaque `ref_*` tokens. The plaintext-to-reference map stays in extension memory and is never serialised into the backend request.
4. The service worker sends the redacted Page IR and user goal to `POST /agent/step`.
5. The Gemini client asks Gemini for exactly one JSON action. The backend validates the action and confirms referenced element IDs exist in the current Page IR.
6. The service worker maps the returned reference back to the live local DOM element, checks the local grant, and executes the action.
7. The page is observed again and the loop continues until Gemini returns `done`, an action is refused, or an error occurs.
8. Each planned step is recorded in the in-memory egress manifest. The viewer shows the session, target URL, action, verdict, and redacted-reference count without showing plaintext.

Important trust boundary: Gemini and the backend see the scene structure and opaque handles, not raw PII. The local extension is the only place that retains the reference-to-plaintext mapping.

## Prerequisites

- Windows, macOS, or Linux
- Python 3.10+
- Node.js 18+
- Google Chrome
- A Gemini API key

Create `backend/.env` locally. Do not commit it:

```ini
GEMINI_API_KEY=your_key_here
HOST=127.0.0.1
PORT=8000
```

## Start the backend

From the repository root, in terminal 1:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Verify it before opening the extension:

- `http://127.0.0.1:8000/health` should return `status: ok` and `gemini_configured: true`.
- `http://127.0.0.1:8000/test` serves the built-in form test page.
- `http://127.0.0.1:8000/manifests/viewer/html` is the audit viewer. Open it in a separate tab before starting a task.

The backend uses `POST /agent/step` for planning and `POST /agent/reset` when a task is stopped. Gemini is called by `backend/app/agent/gemini_client.py`; the client requests JSON and tries `gemini-flash-lite-latest` before `gemini-2.5-flash`. If Gemini quota is exhausted, the current fallback returns a safe `done` response explaining that local redaction was verified; it does not invent an action.

## Build and load the extension

In terminal 2:

```powershell
cd extension
npm install
npm run build
```

In Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose `extension/dist`.
4. Open extension details and enable **Allow access to file URLs** if using `sample.html`.
5. If the backend is not at `http://127.0.0.1:8000`, open the popup settings and set the backend URL.

After code or manifest changes, rebuild and use **Reload** on the extension card. The extension requires access to normal HTTP/HTTPS pages and local files for the supplied test bench.

## Suggested video walkthrough

Keep these three Chrome tabs/windows visible:

1. Test page: `http://127.0.0.1:8000/test`.
2. MUDRA popup or side panel.
3. Audit viewer: `http://127.0.0.1:8000/manifests/viewer/html`.

Suggested narration and actions:

1. Show the form and explain that it contains fields such as email, Aadhaar, card, PAN, UPI, or IFSC values.
2. Open the MUDRA panel and enter `Fill out the registration form with user details`.
3. Start the task. Show capture, detection, redaction, scene building, planning, and execution.
4. Show the outbound payload. Point out that sensitive fields appear as `ref_*` tokens and no plaintext value is present in the request sent to Gemini/backend.
5. Explain that Gemini returns one constrained action at a time: `type`, `click`, `select`, `scroll`, `navigate`, `wait`, `extract`, or `done`.
6. When a submit, cross-origin navigation, credential, or other high-impact effect is proposed, show the confirmation dialog. Approve or refuse it to demonstrate the local grant gate.
7. Return to the audit viewer and show the session, action, status, URL, and redacted token count, with no raw PII.
8. Let the task finish and show the completed state. A refusal or Gemini error fails closed and stops execution rather than running an unapproved action.

For a deterministic local redaction demonstration, open `extension/sample.html`. It contains representative supported PII categories and test values. File URL access must be enabled.

## Safety and implementation notes

- The backend is not the source of truth for authorisation. The grant is derived and enforced in the extension service worker before execution.
- Grants are scoped to the task and current origin. A changed origin is refused.
- The backend validates that element-targeting actions refer to IDs present in the current redacted Page IR.
- The manifest store is in memory, so restarting the backend clears the audit history.
- The current backend CORS policy is open for local development. This is for the demo only and should be tightened for deployment.
- Never place `backend/.env`, a Gemini key, or real personal data in the repository, screenshots, video recordings, or commit history.

## Validation commands

Backend tests:

```powershell
cd backend
.venv\Scripts\python.exe -m pytest ..\tests\backend
```

Extension tests and typecheck:

```powershell
cd extension
npm test
npm run typecheck
npm run build
```

The backend tests cover schemas, alignment, manifest endpoints, and the viewer. The extension tests cover perception, redaction, validation algorithms, and the zero-plaintext safety invariant.

## Troubleshooting

**Health says `gemini_configured: false`**

Confirm `backend/.env` exists, contains `GEMINI_API_KEY`, and restart Uvicorn after changing it.

**The extension cannot inspect the page**

Use a normal HTTP/HTTPS page or enable file URL access for `sample.html`. Refresh the page after loading or reloading the extension.

**The backend returns HTTP 422**

Make sure the extension was built from `integration/mudra-full-pipeline`; the integrated branch aligns the extension payload with the backend Page IR schema.

**The task stops with a refusal**

This is expected when the action is outside the task grant, crosses origins, has exhausted its confirmation allowance, or no grant is active. Start a new task on the intended page and approve only the confirmation you want to demonstrate.

**The viewer is empty**

Start the viewer after the backend is running, then run at least one task. Entries are memory-only and disappear when the backend process restarts.

## Source map for the collaborator

- Extension orchestration: `extension/src/background/service-worker.ts`
- Page capture: `extension/src/content/perception.ts`
- Local redaction: `extension/src/content/redaction.ts` and `extension/src/shared/redact.ts`
- Local grant gate: `extension/src/shared/grant.ts`
- DOM action execution: `extension/src/content/executor.ts`
- Side panel bridge/UI: `extension/sidepanel/`
- FastAPI routes: `backend/app/main.py`
- Gemini integration: `backend/app/agent/gemini_client.py`
- Agent loop and manifest recording: `backend/app/agent/loop.py`
- Audit schema/store: `backend/app/schemas/manifest.py` and `backend/app/manifest_store.py`