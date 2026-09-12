import { ExtensionMessage } from '../shared/messaging';
import type { PanelCommand } from '../shared/agent-events';
import { AgentAction, PageIR } from '../shared/types';
import { redactPageIR, buildOutbound, type OutboundPageIR } from '../shared/redact';
import { emitPhase, emitError, emitDetection, emitRedaction, emitOutbound, emitActivePage, emitObserved,
         emitConfirmRequired, emitActionResolved, emitManifest, replaySnapshot, clearSnapshot } from './panel-events';
import { deriveGrant, checkAction, taskSentence, grantSummary, effectOf, type Grant } from '../shared/grant';
import { stubPlan, STUB_ENABLED_KEY } from './planner-stub';
import { recordEgress, recordAction, readManifest, clearManifest } from './manifest';

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

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
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

  const response = await fetch(`${backendUrl}/agent/step`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      goal: currentGoal,
      page_ir: { ...payload, elements: outboundElements },
      session_id: sessionId,
    }),
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

  return response.json();
}

async function processPageIR(pageIR: PageIR){
  notifyStatus('running', 'Planning next action...');

  const t0 = performance.now();
  emitPhase('DETECTING');
  const redacted = redactPageIR(pageIR);
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
    scene = buildOutbound(redacted, pageIR);
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

  emitOutbound(scene.summary);
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
      emitActionResolved(verdict.effect, 'refused', verdict.reason);
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
        emitActionResolved(effectOf(action), 'refused', execResult.error);
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
        emitActionResolved(effectOf(action), 'refused', execResult?.error ?? 'Execution failed.');
        recordAction(effectOf(action), 'refused', execResult?.error ?? 'Execution failed.');
        emitManifest(readManifest());
        notifyStatus('running', `Execution failed: ${execResult?.error}. Re-observing…`);
      } else {
        emitActionResolved(effectOf(action), 'executed');
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


// The action opens the side panel. The live panel is full height by design,
// which a popup cannot be.
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

chrome.tabs.onActivated.addListener(() => { void emitActivePage(); });
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete') void emitActivePage(); });
