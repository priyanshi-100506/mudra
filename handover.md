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

## Collaborator summary

The project is a privacy-preserving browser agent. The frontend is not just a visual panel: it is the security boundary that observes the current page, detects and redacts sensitive values, creates the anonymous scene sent to the backend, authorises the returned action, and executes that action against the live DOM.

The backend is a stateless planning service around Gemini. It receives a goal and a redacted Page IR, asks Gemini for one structured action, validates the action against the current Page IR, and returns it to the extension. It does not receive the plaintext values behind `ref_*` handles and it does not authorise browser side effects. The extension remains responsible for grants, origin checks, confirmation dialogs, and fail-closed execution.

The integrated branch already connects these pieces:

- The content script captures visible links, buttons, inputs, selects, textareas, and accessible interactive elements.
- Local detection recognises supported PII, including Aadhaar, payment cards, PAN, IFSC, UPI, email, passport, and related patterns.
- Local redaction creates opaque `ref_*` values and keeps the plaintext mapping in memory only.
- The service worker builds the outbound Page IR, calls the backend, translates returned reference IDs back to local DOM IDs, and loops until completion.
- The grant layer allows ordinary actions, refuses actions outside the task/origin policy, and requires confirmation for high-impact effects such as form submission or cross-origin navigation.
- The backend Gemini client requests JSON-only actions and tries the configured Gemini models in order.
- The backend loop validates action element IDs and automatically records an egress manifest entry for each planned step.
- The audit API and HTML viewer expose the session, URL, action, status, and redacted-reference count without exposing values.
- Automated tests cover backend schemas/alignment/manifest endpoints and frontend perception/redaction/safety behavior.

## Frontend compatibility contract

Any frontend change must preserve the existing backend contract and privacy invariant. The collaborator may redesign or improve the UI, but should treat these items as stable interfaces:

### Network contract

The service worker, not a React component, owns backend communication. Keep the backend URL configurable and default it to `http://127.0.0.1:8000`.

The step request must remain equivalent to:

```json
{
	"goal": "user task",
	"page_ir": {
		"url": "https://example.test/",
		"title": "Page title",
		"elements": [
			{
				"id": "ref_ab12cd34",
				"role": "textbox",
				"name": "Email",
				"visible": true,
				"enabled": true,
				"bbox": {"x": 0, "y": 0, "width": 100, "height": 30}
			}
		],
		"text_snippets": [],
		"observed_at": "2026-01-01T00:00:00.000Z"
	},
	"session_id": "request-scoped-session-id"
}
```

Never send the plaintext reference map, raw field values, passwords, credentials, or full unredacted DOM to the backend or Gemini. Do not add logging that prints them.

### Action contract

The frontend must continue to accept and execute the action union defined in `extension/src/shared/types.ts`: `click`, `type`, `select`, `scroll`, `navigate`, `wait`, `extract`, and `done`. Unknown actions must be rejected safely. Element-targeting actions must use the current observation's IDs; stale or missing elements must fail without guessing.

For `done`, stop the loop and show the returned summary. For `error`, show the error and stop the loop. Do not silently execute actions after either state.

### Event and state contract

The side panel receives typed events from the service worker through `extension/sidepanel/bridge.ts` and `extension/src/shared/agent-events.ts`. Preserve these states and make them visible enough for a demo:

- `CAPTURING`
- `DETECTING`
- `REDACTING`
- `BUILDING_SCENE`
- `PLANNING`
- `EXECUTING`
- `AWAITING_CONFIRMATION`
- `REFUSED`
- `COMPLETE`
- `ERROR`

The UI should remain usable if events arrive quickly, if the panel opens after a task has started, or if the backend is unavailable. Keep snapshot replay and unsubscribe behavior intact.

### Security and behavior rules

- Keep redaction and grant enforcement in the service worker/content-script path, outside presentation-only React code.
- Never weaken origin matching, task grants, confirmation requirements, or fail-closed behavior to make a demo smoother.
- Do not use raw field values as React keys, telemetry, labels, screenshots, or status messages.
- Do not call Gemini directly from the extension UI. All planning continues through the backend service worker flow.
- Preserve `ref_*` identity translation: backend actions refer to redacted IDs, while DOM execution uses the local live element ID.
- Preserve automatic re-observation after action execution, navigation load completion, and page mutations.
- Keep the manifest recording path intact so each planned step remains visible in the audit viewer.
- Update or add tests for every changed message, payload, reducer state, redaction behavior, or action mapping.

### Safe frontend change process

1. Start from the frontend branch, then merge or rebase the latest `integration/mudra-full-pipeline` before implementation.
2. Read the relevant types and tests before changing a message or payload.
3. Make the smallest UI or frontend behavior change possible.
4. Run `npm run typecheck`, `npm test`, and `npm run build` from `extension`.
5. Run the backend tests as a compatibility check if the request changes a payload or action flow.
6. Test the real demo with the backend running: start a task, inspect the redacted outbound payload, approve/refuse a confirmation, and verify the audit viewer.
7. Do not merge frontend code that requires backend field names, action names, or routes not present on `integration/mudra-full-pipeline` unless the backend contract is deliberately versioned and updated together.

## Master prompt for Claude Code

Copy the following prompt into Claude Code when asking it to work on the frontend:

```text
You are working on the MUDRA / CLIO browser-agent repository. Work primarily in the frontend under extension/ and preserve compatibility with the final integrated branch integration/mudra-full-pipeline.

PROJECT PURPOSE
MUDRA is a privacy-preserving browser agent. The Chrome extension is the security boundary: it observes visible interactive DOM, detects PII locally, replaces sensitive values with opaque ref_* handles, sends only a redacted Page IR to the FastAPI backend, receives one structured action planned by Gemini, checks that action against a local task/origin grant, optionally asks the user for confirmation, and executes it against the live DOM. The backend never receives the plaintext values behind ref_* handles.

AUTHORITATIVE COMPONENTS
- Frontend orchestration: extension/src/background/service-worker.ts
- Page observation: extension/src/content/perception.ts
- Local redaction: extension/src/content/redaction.ts and extension/src/shared/redact.ts
- Grant and fail-closed action gate: extension/src/shared/grant.ts
- DOM execution: extension/src/content/executor.ts
- Shared types/messages/events: extension/src/shared/types.ts, extension/src/shared/messaging.ts, extension/src/shared/agent-events.ts
- Side panel bridge and UI: extension/sidepanel/
- Backend route contract: backend/app/main.py
- Gemini planner: backend/app/agent/gemini_client.py
- Backend loop and manifest recording: backend/app/agent/loop.py

BRANCH CONTEXT
- mudra-extension-ui is the frontend branch.
- backend/mudra-support is the backend foundation branch.
- integration/mudra-full-pipeline is the final runnable branch and the compatibility target.
- Do not assume main contains the full implementation.

NON-NEGOTIABLE CONTRACTS
1. The service worker owns backend communication. React components must not call Gemini or bypass the service worker.
2. The backend step request remains POST /agent/step with goal, page_ir, and session_id.
3. page_ir sent over the network must contain only redacted element IDs/ref_* handles and safe metadata. Never send plaintext PII, passwords, credentials, the reference map, or unredacted DOM.
4. Preserve the action union: click, type, select, scroll, navigate, wait, extract, done. Unknown actions fail safely.
5. Backend action element IDs are redacted IDs. Translate them back to the current local DOM IDs only inside the extension execution path.
6. Preserve task-scoped and origin-scoped grants, confirmation for high-impact actions, and fail-closed refusal behavior.
7. Preserve the re-observation loop after execution and navigation, including waiting for navigation completion.
8. Preserve typed panel events, snapshot replay, cleanup/unsubscribe, and error states.
9. Preserve automatic egress manifest recording for every planned step.
10. Do not add secrets, real personal data, or raw values to logs, tests, screenshots, telemetry, or commits.

WORKING STYLE
- First inspect the existing types, nearby implementation, and relevant tests. State the local hypothesis before editing.
- Keep changes focused and consistent with the existing TypeScript/React architecture. Do not rewrite working modules or invent a second state machine.
- Prefer existing helpers and message types over new parallel APIs.
- If changing a payload, event, action, or state, update the narrowest relevant tests and check both producer and consumer.
- Do not change backend routes or schema names from the frontend without explicit evidence that the integrated branch changed too.
- Do not weaken security checks to make a demo pass.

VALIDATION REQUIRED
From extension/ run:
	npm run typecheck
	npm test
	npm run build

If the change touches the network payload, action flow, or shared contract, also run from the repository root/backend context:
	.venv\\Scripts\\python.exe -m pytest ..\\tests\\backend

Then manually verify with the backend running on http://127.0.0.1:8000:
- open http://127.0.0.1:8000/test
- load extension/dist in Chrome
- start a form task from the MUDRA panel
- confirm the outbound payload contains ref_* handles rather than plaintext
- verify a confirmation dialog appears for a high-impact action
- verify refusal stops execution
- verify completion and the audit viewer at /manifests/viewer/html

DELIVERABLE
Implement only the requested frontend change. At the end, report changed files, compatibility considerations, tests run and their results, and any remaining limitation. Do not commit or push unless explicitly asked.
```