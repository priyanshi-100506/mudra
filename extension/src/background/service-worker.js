let currentGoal = '';
let isAgentRunning = false;
let activeTabId = null;
let sessionId = '';
let backendUrl = 'http://127.0.0.1:8000';
// Load persisted backend URL on startup
chrome.storage.local.get('backendUrl', (res) => {
    if (res.backendUrl)
        backendUrl = res.backendUrl;
});
// Listen for storage changes so the popup URL update takes effect immediately
chrome.storage.onChanged.addListener((changes) => {
    if (changes.backendUrl?.newValue) {
        backendUrl = changes.backendUrl.newValue;
    }
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message).catch((err) => {
        notifyStatus('error', `Unexpected error: ${err.message}`);
    });
    return true; // keep channel open for async
});
async function handleMessage(message) {
    switch (message.type) {
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
            notifyStatus('running', `🚀 Session ${sessionId.slice(0, 8)} started.`);
            await triggerObservation();
            break;
        }
        case 'STOP_TASK': {
            isAgentRunning = false;
            // Reset backend session state
            fetch(`${backendUrl}/agent/reset`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: sessionId }),
            }).catch(() => { });
            notifyStatus('idle', '⏹ Task stopped by user.');
            break;
        }
        case 'PAGE_IR_CAPTURED': {
            if (!isAgentRunning)
                return;
            await processPageIR(message.pageIR);
            break;
        }
    }
}
async function triggerObservation() {
    if (!activeTabId || !isAgentRunning)
        return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ?? '';
    if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) {
        notifyStatus('error', '⚠️ Cannot inspect this page. Navigate to a normal website first.');
        isAgentRunning = false;
        return;
    }
    try {
        // Ensure content script is injected (catches pages loaded before extension install)
        await chrome.scripting.executeScript({
            target: { tabId: activeTabId },
            files: ['src/content/index.js'],
        }).catch(() => { }); // ignore if already injected
        await chrome.tabs.sendMessage(activeTabId, { type: 'CAPTURE_PAGE_IR' });
    }
    catch (err) {
        notifyStatus('error', `⚠️ Failed to inspect page. Try refreshing it. (${err.message})`);
        isAgentRunning = false;
    }
}
async function processPageIR(pageIR) {
    notifyStatus('running', '🤔 Planning next action...');
    try {
        const response = await fetch(`${backendUrl}/agent/step`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                goal: currentGoal,
                page_ir: pageIR,
                session_id: sessionId,
            }),
        });
        if (!response.ok) {
            const errBody = await response.json().catch(() => ({ detail: response.statusText }));
            throw new Error(`Backend HTTP ${response.status}: ${errBody.detail ?? response.statusText}`);
        }
        const data = await response.json();
        const action = data.action;
        if (data.status === 'done') {
            isAgentRunning = false;
            notifyStatus('completed', `✅ Done: ${data.message}`);
            return;
        }
        if (data.status === 'error') {
            isAgentRunning = false;
            notifyStatus('error', `❌ ${data.message}`);
            return;
        }
        // Show action being executed
        notifyStatus('running', `⚡ ${data.message}`);
        if (activeTabId && isAgentRunning) {
            // Execute action in content script
            const execResult = await chrome.tabs.sendMessage(activeTabId, {
                type: 'EXECUTE_ACTION',
                action,
            }).catch((err) => ({ success: false, error: err.message }));
            if (!execResult?.success) {
                notifyStatus('running', `⚠️ Execution warning: ${execResult?.error}. Retrying observation...`);
            }
            // After navigate: wait for tab to finish loading before re-observing
            if (action.action === 'navigate') {
                notifyStatus('running', `🌐 Navigating to ${action.url}...`);
                await waitForTabLoad(activeTabId);
                // Update activeTabId in case Chrome reassigned it
                const [newTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (newTab?.id)
                    activeTabId = newTab.id;
            }
            else if (action.action === 'wait') {
                // Backend already slept; just give DOM a moment to settle
                await sleep(200);
            }
            else {
                // Small settle delay for DOM mutations (React re-renders, etc.)
                await sleep(500);
            }
            await triggerObservation();
        }
    }
    catch (err) {
        notifyStatus('error', `❌ ${err.message}`);
        isAgentRunning = false;
    }
}
/** Waits until the given tab's status is 'complete'. */
function waitForTabLoad(tabId) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
        }, 15_000); // 15s safety timeout
        const listener = (updatedTabId, info) => {
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
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function notifyStatus(status, message) {
    chrome.runtime.sendMessage({
        type: 'TASK_STATUS',
        status,
        message,
    }).catch(() => { });
}
export {};
