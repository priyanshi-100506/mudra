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
    // Always answer, including on a throw: an unanswered channel surfaces to
    // the sender as "the message channel closed before a response was
    // received" rather than as the execution failure it actually is.
    executeAction(message.action)
      .then((result) => sendResponse(result))
      .catch((err: unknown) =>
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }));
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



