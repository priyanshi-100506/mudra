import { capturePageIR } from './perception';
import { redactPageIR } from './redaction';
import { executeAction } from './executor';
import { ExtensionMessage } from '../shared/messaging';

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  if (message.type === 'CAPTURE_PAGE_IR') {
    const rawIR = capturePageIR();
    const { sanitizedIR } = redactPageIR(rawIR);
    chrome.runtime.sendMessage({
      type: 'PAGE_IR_CAPTURED',
      pageIR: sanitizedIR,
    });
    sendResponse({ success: true });
  } else if (message.type === 'EXECUTE_ACTION') {
    executeAction(message.action).then((result) => {
      sendResponse(result);
    });
    return true; // Asynchronous response signal
  }
});
import { toggleMudra } from './mudra-mount';

chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg?.type === 'TOGGLE_MUDRA') toggleMudra();
});

import { runRedactionOverlay, clearHighlights, type HighlightTarget } from './highlight';
import { currentElementMap } from './perception';

chrome.runtime.onMessage.addListener((msg: { type?: string; targets?: HighlightTarget[] }) => {
  if (msg?.type === 'MUDRA_HIGHLIGHT' && msg.targets) {
    runRedactionOverlay(msg.targets, (id) => currentElementMap.get(id)?.deref());
  } else if (msg?.type === 'MUDRA_HIGHLIGHT_CLEAR') {
    clearHighlights();
  }
});

import { askConfirmation, dismissConfirmation, type ConfirmRequest } from './confirm-overlay';

chrome.runtime.onMessage.addListener(
  (msg: { type?: string; request?: ConfirmRequest }, _sender, sendResponse) => {
    // The panel asks the same question at the same time. Whichever surface the
    // user answers first wins, and the worker tells the other to stand down.
    if (msg?.type === 'MUDRA_DISMISS_CONFIRM') {
      dismissConfirmation();
      return;
    }
    if (msg?.type !== 'MUDRA_CONFIRM') return;
    askConfirmation(msg.request as ConfirmRequest).then((decision) =>
      sendResponse({ decision }),
    );
    return true; // async
  },
);
