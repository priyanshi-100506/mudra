import { ExtensionMessage } from '../shared/messaging';
import type { PanelCommand } from '../shared/agent-events';
import { AgentAction, PageIR } from '../shared/types';
import { redactPageIR, buildOutbound } from '../shared/redact';
import { emitPhase, emitError, emitDetection, emitRedaction, emitOutbound, emitActivePage,
         emitConfirmRequired, emitActionResolved, replaySnapshot, clearSnapshot } from './panel-events';
import { deriveGrant, checkAction, confirmSentence, effectOf, type Grant } from '../shared/grant';
import { stubPlan, STUB_ENABLED_KEY } from './planner-stub';

let currentGoal = '';
let isAgentRunning = false;
let activeTabId: number | null = null;
let sessionId = '';
let backendUrl = 'http://127.0.0.1:8000';
let grant: Grant | null = null;
let pendingResolve: ((decision: 'authorise' | 'refuse') => void) | null = null;
let usePlannerStub = false;
let stubStep = 0;
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
  handleMessage(message).catch((err) => {
    notifyStatus('error', `Unexpected error: ${err.message}`);
  });
  return true; // keep channel open for async
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
      stubStep = 0;
      { let o = tab.url ?? '';
        try { o = new URL(tab.url ?? '').origin; } catch { /* keep raw */ }
        grant = deriveGrant(message.goal, o); }
      notifyStatus('running', `Session ${sessionId.slice(0, 8)} started.`);
      await emitActivePage();
      emitPhase('CAPTURING');
      await triggerObservation();
      break;
    }

    case 'STOP_TASK': {
      isAgentRunning = false;
      emitPhase('IDLE');
      // Reset backend session state
      fetch(`${backendUrl}/agent/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      }).catch(() => {});
      notifyStatus('idle', 'Task stopped by user.');
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
  elements: unknown[],
  pageIR: PageIR,
): Promise<{ status: string; message: string; action: AgentAction }> {
  const response = await fetch(`${backendUrl}/agent/step`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      goal: currentGoal,
      page_ir: { ...pageIR, elements },
      session_id: sessionId,
    }),
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(`Backend HTTP ${response.status}: ${errBody.detail ?? response.statusText}`);
  }
  return response.json();
}

async function processPageIR(pageIR: PageIR){
  notifyStatus('running', 'Planning next action...');

  emitPhase('DETECTING');
  const redacted = redactPageIR(pageIR);
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

  emitPhase('BUILDING_SCENE');
  let scene;
  try {
    scene = buildOutbound(redacted);
  } catch (err: any) {
    isAgentRunning = false;
    emitError(err.message);
    notifyStatus('error', err.message);
    return;
  }
  emitOutbound(scene.summary);

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
      : await fetchPlan(scene.payload.elements, pageIR);

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
      emitActionResolved(verdict.effect, 'refused', verdict.reason);
      emitPhase('REFUSED');
      notifyStatus('error', `Refused: ${verdict.reason}`);
      isAgentRunning = false;
      return;
    }

    if (verdict.kind === 'confirm') {
      emitPhase('AWAITING_CONFIRMATION');
      emitConfirmRequired({
        sentence: confirmSentence(verdict.effect, currentOrigin),
        origin: currentOrigin,
        effect: verdict.effect,
        targetRole: (action as { element_id?: string }).element_id ?? 'page',
        targetRef: (action as { element_id?: string }).element_id ?? '—',
      });

      const decision = await new Promise<'authorise' | 'refuse'>((resolve) => {
        pendingResolve = resolve;
      });

      if (decision === 'refuse') {
        emitActionResolved(verdict.effect, 'refused', 'Declined by the user.');
        emitPhase('REFUSED');
        notifyStatus('idle', 'Action declined.');
        isAgentRunning = false;
        return;
      }
      if (grant) grant.usesRemaining -= 1;
    }

    emitActionResolved(effectOf(action), 'executed');
    emitPhase('EXECUTING');

    if (activeTabId && isAgentRunning) {
      // Execute action in content script
      const execResult = await chrome.tabs.sendMessage(activeTabId, {
        type: 'EXECUTE_ACTION',
        action,
      }).catch((err: any) => ({ success: false, error: err.message }));

      if (!execResult?.success) {
        notifyStatus('running', `Execution warning: ${execResult?.error}. Retrying observation...`);
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


chrome.tabs.onActivated.addListener(() => { void emitActivePage(); });
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete') void emitActivePage(); });
