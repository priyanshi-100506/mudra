import { capturePageIR } from './perception';
import { collectImageRegions } from './image-regions';
import { plantCanaries } from './canary-node';
import { generateCanaries } from '../shared/canary';
import { redactPageIR } from './redaction';
import { executeAction } from './executor';
import { ExtensionMessage } from '../shared/messaging';

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  if (message.type === 'CAPTURE_PAGE_IR') {
    // Plant before capture, remove after, whatever happens. The canaries
    // must be in the DOM at the moment perception walks it, or they travel a
    // path real PII does not and prove nothing.
    const canaries = generateCanaries();
    const unplant = plantCanaries(canaries);
    let sanitizedIR;
    try {
      sanitizedIR = redactPageIR(capturePageIR()).sanitizedIR;
    } finally {
      unplant();
    }
    chrome.runtime.sendMessage({
      type: 'PAGE_IR_CAPTURED',
      pageIR: sanitizedIR,
      // The values travel to the worker so it can scan its own outbound body
      // for them. They are never put in a payload; that is what is being
      // tested.
      canaries,
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



/**
 * Reports the page's own coordinate space to the background.
 *
 * The background needs this because it holds the screenshot, which is in
 * device pixels, while every bbox in the PageIR is in CSS pixels. Only the
 * page knows its `devicePixelRatio`, so it has to travel across this boundary
 * explicitly rather than being assumed to be 1.
 */
chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, sendResponse) => {
  if (msg?.type === 'GET_VIEWPORT_INFO') {
    sendResponse({
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      // The regions the DOM cannot account for, so OCR can be narrowed to
      // them instead of sweeping the whole capture.
      imageRegions: collectImageRegions(),
    });
  }
});
