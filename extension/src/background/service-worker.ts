import { ExtensionMessage } from '../shared/messaging';
import type { PanelCommand } from '../shared/agent-events';
import { AgentAction, PageIR } from '../shared/types';
import { redactPageIR, buildOutbound, type OutboundPageIR } from '../shared/redact';
import { emitPhase, emitError, emitDetection, emitRedaction, emitOutbound, emitActivePage, emitObserved,
         emitConfirmRequired, emitActionResolved, emitManifest, emitPlan, emitBlocked,
         emitPlanner, replaySnapshot, clearSnapshot } from './panel-events';
import { deriveGrant, checkAction, taskSentence, grantSummary, effectOf, type Grant } from '../shared/grant';
import { stubPlan, STUB_ENABLED_KEY } from './planner-stub';
import { recordEgress, recordAction, readManifest, clearManifest, recordCanaries } from './manifest';
import { registerCanaries, assertNoCanaries, scanPlannerResponse, canaryReport,
         CanaryEscape, currentCanaries } from '../shared/canary';
import { runVisualPass, noImage, type VisualPassResult } from './visual-pass';
import { utf8ByteLength } from '../shared/evidence';
import { isSensitive } from '../shared/redact';

let currentGoal = '';
let isAgentRunning = false;
let activeTabId: number | null = null;
let sessionId = '';
let backendUrl = 'http://127.0.0.1:8000';
let grant: Grant | null = null;
let pendingResolve: ((decision: 'authorise' | 'refuse') => void) | null = null;
let usePlannerStub = false;
let stubStep = 0;
let refusalCount = 0;
let lastRefMap = new Map<string, { elementId: string; value: string }>();
const MAX_REFUSALS = 3;
chrome.storage.local.get(STUB_ENABLED_KEY, (res) => {
  usePlannerStub = Boolean(res?.[STUB_ENABLED_KEY]);
});
chrome.storage.onChanged.addListener((changes) => {
  if (STUB_ENABLED_KEY in changes) usePlannerStub = Boolean(changes[STUB_ENABLED_KEY].newValue);
});

// Load persisted backend URL on startup
chrome.storage.local.get('backendUrl', (res) => {
  if (res.backendUrl) backendUrl = res.backendUrl;
});

// Listen for storage changes so the popup URL update takes effect immediately
chrome.storage.onChanged.addListener((changes) => {
  if (changes.backendUrl?.newValue) {
    backendUrl = changes.backendUrl.newValue;
  }
});

/**
 * Asks the backend which planner is answering, and tells the panel.
 *
 * Read fresh each run rather than cached: the whole point is to notice when
 * the backend changed under us, and a cached answer would report the one we
 * expected instead of the one that is live.
 */
async function reportPlanner(): Promise<void> {
  try {
    const res = await fetch(`${backendUrl}/health`);
    const h = await res.json() as {
      status?: string; planner?: string; offline?: boolean;
      model?: string | null; detail?: string | null;
    };
    emitPlanner({
      planner: h.planner ?? 'unknown',
      offline: Boolean(h.offline),
      model: h.model ?? null,
      healthy: h.status === 'ok',
      detail: h.detail ?? null,
    });
  } catch (err) {
    // A backend we cannot reach is itself worth saying out loud.
    emitPlanner({
      planner: 'unreachable', offline: false, model: null, healthy: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Relays a question to the backend and hands the prose answer back. */
async function handleChat(message: { message: string; context?: string }) {
  const response = await fetch(`${backendUrl}/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId || 'panel',
      message: message.message,
      goal: currentGoal || undefined,
      // Redacted context only. The panel builds this from what it was shown,
      // which never contained a value in the first place.
      context: message.context,
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(String(body.detail ?? response.statusText));
  }
  return response.json() as Promise<{ reply: string; turns: number }>;
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  // The one message that genuinely returns something. Everything else is
  // acknowledged immediately; see the note below.
  if (message.type === 'PANEL_CHAT') {
    handleChat(message)
      .then((r) => sendResponse(r))
      .catch((err: unknown) =>
        sendResponse({ error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  // Acknowledge synchronously, then let the work run on its own.
  //
  // This used to return true — "a response is coming" — and never send one.
  // START_TASK now awaits the user's authorisation and then the whole agent
  // run, so the channel was held open for the length of the task; when the
  // popup closed, Chrome tore it down and the sender saw "A listener
  // indicated an asynchronous response by returning true, but the message
  // channel closed before a response was received". No caller reads a reply
  // here — progress arrives as AGENT_* events — so the ack is the response.
  void handleMessage(message).catch((err) => {
    notifyStatus('error', `Unexpected error: ${err.message}`);
  });
  sendResponse({ ok: true });
  return false;
});

async function handleMessage(message: ExtensionMessage | PanelCommand) {
  switch (message.type) {
    case 'PANEL_READY': {
      await emitActivePage();
      replaySnapshot();
      break;
    }
    case 'PANEL_CONFIRM': {
      pendingResolve?.((message as { decision: 'authorise' | 'refuse' }).decision);
      pendingResolve = null;
      break;
    }
    case 'START_TASK': {
      currentGoal = message.goal;
      isAgentRunning = true;
      sessionId = crypto.randomUUID();

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        notifyStatus('error', 'No active tab found.');
        return;
      }

      activeTabId = tab.id;
      clearSnapshot();
      lastRefMap.clear();
      clearManifest();
      stubStep = 0;
      refusalCount = 0;
      let origin = tab.url ?? '';
      try { origin = new URL(tab.url ?? '').origin; } catch { /* keep raw */ }
      grant = deriveGrant(message.goal, origin);

      await emitActivePage();

      // One question, asked before anything is observed: the user sees the
      // task, the origin and exactly what the grant permits, and decides once.
      // Nothing is read from the page until they have.
      emitPhase('AWAITING_CONFIRMATION');
      emitConfirmRequired({
        sentence: taskSentence(grant),
        origin,
        effect: grant.task,
        targetRole: 'task',
        targetRef: message.goal,
        permits: grantSummary(grant),
        uses: grant.maxUses,
      });

      const authorised = await new Promise<'authorise' | 'refuse'>((resolve) => {
        pendingResolve = resolve;
      });
      pendingResolve = null;

      if (authorised === 'refuse') {
        isAgentRunning = false;
        grant = null;
        emitPhase('IDLE');
        notifyStatus('idle', 'Task declined.');
        break;
      }

      grant.authorised = true;
      notifyStatus('running', `Session ${sessionId.slice(0, 8)} started.`);
      emitPhase('CAPTURING');
      await triggerObservation();
      break;
    }

    case 'TOGGLE_PANEL': {
      await togglePanelOnActiveTab();
      break;
    }

    case 'STOP_TASK': {
      // A full teardown, not just a flag. This used to leave the worker's
      // snapshot, grant, ref map and manifest in place, so the panel cleared
      // itself while the run carried on underneath and reopening the popup
      // replayed the old task.
      isAgentRunning = false;

      // A task parked on the authorisation dialog is awaiting this promise.
      // Settle it, or START_TASK stays suspended for the life of the worker.
      pendingResolve?.('refuse');
      pendingResolve = null;

      grant = null;
      lastRefMap.clear();
      clearManifest();
      clearSnapshot();
      stubStep = 0;
      refusalCount = 0;
      currentGoal = '';

      if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, { type: 'MUDRA_HIGHLIGHT_CLEAR' }).catch(() => {});
      }

      // Reset backend session state
      if (sessionId) {
        fetch(`${backendUrl}/agent/reset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId }),
        }).catch(() => {});
      }
      sessionId = '';

      emitPhase('IDLE');
      void emitActivePage();
      notifyStatus('idle', 'Ready.');
      break;
    }

    case 'PAGE_IR_CAPTURED': {
      // Minted and planted by the content script, which is where the DOM is.
      // The worker adopts them because it is where the network is.
      registerCanaries(message.canaries ?? []);
      if (!isAgentRunning) return;
      await processPageIR(message.pageIR);
      break;
    }
  }
}

async function triggerObservation() {
  if (!activeTabId || !isAgentRunning) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? '';

  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) {
    notifyStatus('error', 'Cannot inspect this page. Navigate to a normal website first.');
    isAgentRunning = false;
    return;
  }

  try {
    // Ensure content script is injected (catches pages loaded before extension install)
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      files: ['src/content/index.js'],
    }).catch(() => {}); // ignore if already injected

    await chrome.tabs.sendMessage(activeTabId, { type: 'CAPTURE_PAGE_IR' });
  } catch (err: any) {
    notifyStatus('error', `Failed to inspect page. Try refreshing it. (${err.message})`);
    isAgentRunning = false;
  }
}

/** The real planner call, extracted so the stub can stand in for it. */
async function fetchPlan(
  payload: OutboundPageIR,
): Promise<{ status: string; message: string; action: AgentAction }> {
  // The backend's PageElement is keyed by `id`. Our scene graph is keyed by
  // `ref` — for sensitive fields that is a random handle, and the mapping
  // back to a live element never leaves this worker.
  //
  // Only the payload `buildOutbound` produced is sent. The raw PageIR is not
  // spread in alongside it: doing so previously carried unredacted
  // `text_snippets` past the no-leak assertion and onto the wire.
  const outboundElements = payload.elements.map((e) => ({
    id: e.ref,
    role: e.role,
    name: e.name,
    input_type: e.input_type,
    visible: true,
    enabled: true,
    bbox: e.bbox,
  }));

  // Serialise first, then scan, then send. The scan runs on this exact
  // string and not on the object it came from: the leak worth catching is a
  // value riding out inside some nested field nobody thought to walk, and
  // JSON.stringify is the only thing that sees all of them.
  const body = JSON.stringify({
    goal: currentGoal,
    page_ir: { ...payload, elements: outboundElements },
    session_id: sessionId,
  });
  assertNoCanaries(body);

  const response = await fetch(`${backendUrl}/agent/step`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({ detail: response.statusText }));
    // FastAPI returns validation errors as an array; flatten them so a 422
    // says which field was rejected rather than "[object Object]".
    const detail = Array.isArray(errBody.detail)
      ? errBody.detail
          .map((item: { loc?: unknown[]; msg?: string }) =>
            `${item.loc?.join('.') ?? 'request'}: ${item.msg ?? 'invalid value'}`)
          .join('; ')
      : String(errBody.detail ?? response.statusText);
    throw new Error(`Backend HTTP ${response.status}: ${detail}`);
  }

  // A canary coming back means the boundary was crossed somewhere upstream —
  // possibly not by us, since a value can reach a provider by paths outside
  // this extension. Either way the value is out and the session stops.
  const text = await response.text();
  const echoed = scanPlannerResponse(text);
  if (echoed.length > 0) {
    throw new CanaryEscape(
      'Canary echoed by the planner: a tracer value crossed the boundary upstream. ' +
        'The session was stopped.',
      canaryReport(echoed),
    );
  }
  return JSON.parse(text);
}

async function processPageIR(pageIR: PageIR){
  notifyStatus('running', 'Planning next action...');

  void reportPlanner();

  const t0 = performance.now();
  emitPhase('DETECTING');
  // The visual pass runs before redaction counts are reported, because those
  // counts are partly what it found. It is allowed to fail: `runVisualPass`
  // never throws, and a failure means no image, not no observation.
  const visual: VisualPassResult = activeTabId === null
    ? noImage('no active tab to capture')
    : await runVisualPass({
        tabId: activeTabId,
        // The DOM already knows which fields are sensitive; reusing that
        // judgement here keeps one definition of "sensitive" in the system.
        domSensitiveBoxes: pageIR.elements
          .filter((el) => isSensitive(el) && el.bbox)
          .map((el) => ({ bbox: el.bbox!, inputType: el.input_type, name: el.name })),
        // Local only. Passed so the verifier can confirm none survived.
        knownPiiValues: pageIR.elements
          .map((el) => el.value ?? '')
          .filter(Boolean),
        canaryText: currentCanaries().map((c) => c.value).join('\n'),
        canaries: { planted: currentCanaries().length, escaped: 0 },
      });

  const redacted = redactPageIR(pageIR, {
    faces: visual.faces,
    ocrRegions: visual.ocrRegions,
    maskedRegions: visual.maskedRegions,
    reOcrVerified: visual.reOcrVerified,
    canariesPlanted: currentCanaries().length,
    canariesEscaped: 0,
  });
  // The panel needs the totals at observation time: how much of the page was
  // described, and how much of it was sealed. Everything else that carries a
  // count arrives later, once the payload has been built.
  emitObserved(redacted.elements.length, redacted.refMap.size);
  emitDetection(redacted.detection);

  emitPhase('REDACTING');
  emitRedaction(redacted.redaction, redacted.fields);

  // show the redaction happening on the page itself
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, {
      type: 'MUDRA_HIGHLIGHT',
      targets: redacted.fields.map((f) => ({
        ref: f.ref,
        elementId: f.elementId,
        sensitive: f.sensitive,
      })),
    }).catch(() => {});
  }

  const stubOnAtCapture = await chrome.storage.local
    .get(STUB_ENABLED_KEY)
    .then((r) => Boolean(r?.[STUB_ENABLED_KEY]))
    .catch(() => false);

  emitPhase('BUILDING_SCENE');
  let scene;
  try {
    scene = buildOutbound(redacted, pageIR, {
      screenshotB64: visual.screenshotB64,
      reOcrVerified: visual.reOcrVerified,
    });
  } catch (err: any) {
    isAgentRunning = false;
    emitError(err.message);
    notifyStatus('error', err.message);
    return;
  }
  const localMs = performance.now() - t0;
  console.log('[mudra:perf] local pipeline', Math.round(localMs), 'ms',
    '| fields', scene.summary.fieldsDescribed,
    '| refs', redacted.redaction.textReferences);

  // The last gate before anything leaves. Scanning the serialised body — not
  // the object — is the point: the leak worth catching is a value nested
  // somewhere nobody thought to walk.
  const outboundBody = JSON.stringify(scene.payload);
  try {
    assertNoCanaries(outboundBody);
    recordCanaries(canaryReport([]));
  } catch (err) {
    // The single boundary where a canary escape becomes something a person
    // sees. Throwing was right; ending up indistinguishable from a hang is
    // not. This is MUDRA's strongest safety property firing, and it has to
    // read that way — a silent stop would look like a crash, which is the
    // worst possible presentation of the best thing this system does.
    const report = err instanceof CanaryEscape
      ? err.report
      : canaryReport(currentCanaries());
    recordCanaries(report);
    emitManifest(readManifest());
    isAgentRunning = false;
    emitPhase('BLOCKED');
    emitBlocked(
      'Blocked: redactor fault, canary escaped',
      err instanceof Error ? err.message : String(err),
      report,
    );
    // Stopped for good. No retry and no degraded continue: a redactor we
    // cannot trust does not get a second attempt at the same page.
    notifyStatus('error', 'Blocked: redactor fault, canary escaped');
    return;
  }

  emitOutbound(scene.summary);

  // The panel shows the body exactly as it was serialised for the canary
  // scan, not a prettified copy — a re-serialised string is a different
  // string from the one that was actually checked and sent.
  void chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'EVIDENCE_BODY',
    sentBody: outboundBody,
    sentBytes: utf8ByteLength(outboundBody),
  }).catch(() => { /* no panel open, or no offscreen document; not fatal */ });

  // The ref → element mapping never leaves this worker. It is the point at
  // which a reference the planner merely discussed becomes a target we act
  // on, and it is consulted only after the gate has approved the action.
  // Merge rather than replace: refs are stable per field, so a rebuilt map
  // carries the same handles. Merging keeps a plan made one observation ago
  // resolvable while the task is still running.
  for (const [k, v] of redacted.refMap) lastRefMap.set(k, v);
  await recordEgress(scene.payload, stubOnAtCapture ? 'local (planner stubbed)' : backendUrl, {
    fields: scene.summary.fieldsDescribed,
    refs: redacted.redaction.textReferences,
    redactions: redacted.redaction.textReferences + redacted.redaction.maskedRegions,
  });
  emitManifest(readManifest());

  emitPhase('PLANNING');

  try {
    // The planner is the only step that can be stubbed for the demo.
    // Everything below this line is the real path, unchanged — the
    // refusal is not mocked, only the hostile plan that provokes it.
    const stubOn = await chrome.storage.local
      .get(STUB_ENABLED_KEY)
      .then((r) => Boolean(r?.[STUB_ENABLED_KEY]))
      .catch(() => usePlannerStub);

    const data = stubOn
      ? stubPlan(stubStep++, scene.payload.elements)
      : await fetchPlan(scene.payload);

    const action: AgentAction = data.action;

    // Report the reply before the gate sees it. If the gate then refuses,
    // the panel shows both halves: what was asked for, and what happened.
    emitPlan(data.status, data.message, data.action, stubOn);

    if (data.status === 'done') {
      isAgentRunning = false;
      emitPhase('COMPLETE');
      notifyStatus('completed', `Done: ${data.message}`);
      return;
    }

    if (data.status === 'error') {
      isAgentRunning = false;
      emitError(data.message);
      notifyStatus('error', `${data.message}`);
      return;
    }

    // Show action being executed
    notifyStatus('running', `${data.message}`);

    // ── the gate: every action is checked before execution ──
    let currentOrigin = '';
    try {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      currentOrigin = new URL(t?.url ?? '').origin;
    } catch { /* leave blank; the check will refuse */ }

    const verdict = checkAction(action, grant, currentOrigin);

    if (verdict.kind === 'refuse') {
      // Refuse, log, and continue with the remaining steps. A refusal is a
      // bounded outcome for one action, not a failure of the whole task —
      // the agent carries on with what it is still authorised to do.
      emitActionResolved(verdict.effect, 'refused', verdict.reason, targetOf(action));
      recordAction(verdict.effect, 'refused', verdict.reason);
      emitManifest(readManifest());
      notifyStatus('running', `Refused: ${verdict.reason}`);
      refusalCount += 1;

      if (refusalCount >= MAX_REFUSALS) {
        emitPhase('REFUSED');
        emitError('Too many refused actions — stopping. The plan is not aligned with your task.');
        isAgentRunning = false;
        return;
      }

      await sleep(400);
      await triggerObservation();
      return;
    }

    // No second question. The task was authorised before the page was read,
    // and the gate above has already decided this action against that grant.
    // A high-impact effect spends the grant's single use as it runs.
    if (verdict.consumesUse && grant) grant.usesRemaining -= 1;

    emitPhase('EXECUTING');

    if (activeTabId && isAgentRunning) {
      // Execute action in content script
      // Resolve the reference to a live element id. The planner named a
      // handle; only we can turn that into a target.
      const targeted = (() => {
        const a = action as { element_id?: string };
        if (!a.element_id) return action;
        const mapped = lastRefMap.get(a.element_id)?.elementId;
        return mapped ? { ...action, element_id: mapped } : action;
      })();

      const execResult = await chrome.tabs.sendMessage(activeTabId, {
        type: 'EXECUTE_ACTION',
        action: targeted,
      }).catch((err: any) => ({ success: false, error: err.message }));

      // The outcome is only known now. A handle refusal is the boundary
      // working; a DOM failure is a bug. Both are logged, but they are not
      // the same thing and the manifest must not conflate them.
      const refusedByExecutor =
        typeof execResult?.error === 'string' && execResult.error.startsWith('Refused (');

      if (refusedByExecutor) {
        emitActionResolved(effectOf(action), 'refused', execResult.error, targetOf(action));
        recordAction(effectOf(action), 'refused', execResult.error);
        emitManifest(readManifest());
        notifyStatus('running', execResult.error);
        refusalCount += 1;
        if (refusalCount >= MAX_REFUSALS) {
          emitPhase('REFUSED');
          emitError('Too many refused actions — stopping.');
          isAgentRunning = false;
          return;
        }
      } else if (!execResult?.success) {
        emitActionResolved(effectOf(action), 'refused', execResult?.error ?? 'Execution failed.', targetOf(action));
        recordAction(effectOf(action), 'refused', execResult?.error ?? 'Execution failed.');
        emitManifest(readManifest());
        notifyStatus('running', `Execution failed: ${execResult?.error}. Re-observing…`);
      } else {
        emitActionResolved(effectOf(action), 'executed', undefined, targetOf(action));
        recordAction(effectOf(action), 'executed');
        emitManifest(readManifest());
      }

      // After navigate: wait for tab to finish loading before re-observing
      if (action.action === 'navigate') {
        notifyStatus('running', `Navigating to ${(action as any).url}...`);
        await waitForTabLoad(activeTabId);
        // Update activeTabId in case Chrome reassigned it
        const [newTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (newTab?.id) activeTabId = newTab.id;
      } else if (action.action === 'wait') {
        // Backend already slept; just give DOM a moment to settle
        await sleep(200);
      } else {
        // Small settle delay for DOM mutations (React re-renders, etc.)
        await sleep(500);
      }

      await triggerObservation();
    }
  } catch (err: any) {
    // A canary echoed by the planner arrives here. It means the boundary was
    // crossed upstream — possibly not even by us, since a value can reach a
    // provider by paths outside this extension. It is still a hard stop, and
    // still gets the named state rather than a generic error.
    if (err instanceof CanaryEscape) {
      recordCanaries(err.report);
      emitManifest(readManifest());
      isAgentRunning = false;
      emitPhase('BLOCKED');
      emitBlocked('Blocked: canary echoed by the planner', err.message, err.report);
      notifyStatus('error', 'Blocked: canary echoed by the planner');
      return;
    }
    emitError(err.message);
    notifyStatus('error', `❌ ${err.message}`);
    isAgentRunning = false;
  }
}

/** Waits until the given tab's status is 'complete'. */
function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15_000); // 15s safety timeout

    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        // Extra settle for JS-heavy SPAs
        setTimeout(resolve, 600);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** The handle an action named, for the record. Never a value. */
function targetOf(action: AgentAction): string | undefined {
  const a = action as { element_id?: string; url?: string };
  return a.element_id ?? a.url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function notifyStatus(status: 'idle' | 'running' | 'completed' | 'error', message: string) {
  chrome.runtime.sendMessage({
    type: 'TASK_STATUS',
    status,
    message,
  }).catch(() => {});
}


// The action opens the popup, which renders the same panel. The side panel
// stays registered for the full-height view; opening it on action click would
// be ignored anyway while a default_popup is set.
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});

/**
 * Shows or hides the floating panel on the active tab.
 *
 * The content script is injected here rather than declared in the manifest —
 * nothing runs on a page until the user asks for it. Injecting twice is
 * harmless; the module is idempotent and the toggle is what decides.
 */
async function togglePanelOnActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const url = tab.url ?? '';
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
    notifyStatus('error', 'Mudra cannot open on this page.');
    return;
  }
  await chrome.scripting
    .executeScript({ target: { tabId: tab.id }, files: ['src/content/index.js'] })
    .catch(() => {});
  await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_MUDRA' }).catch(() => {});
}

chrome.commands?.onCommand.addListener((command) => {
  if (command === 'toggle-panel') void togglePanelOnActiveTab();
});

chrome.tabs.onActivated.addListener(() => { void emitActivePage(); });
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete') void emitActivePage(); });
