/**
 * Offscreen entry point.
 *
 * The service worker owns the pipeline; this document owns the pixels. The
 * split exists because a worker cannot decode an image or run WASM inference,
 * and keeping the raw capture on this side of the boundary means it never has
 * to pass through code that also talks to the network.
 */
import { initVision, visionStatus } from './vision';

// Warm the detector as soon as the document exists, so the first observation
// does not pay the model load. A failure is recorded, not thrown: the
// pipeline reads the status and withholds the image.
void initVision();

chrome.runtime.onMessage.addListener((msg: { type?: string; target?: string }, _s, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'VISION_STATUS') {
    initVision().then(sendResponse);
    return true;
  }
  if (msg.type === 'VISION_STATUS_SYNC') {
    sendResponse(visionStatus());
  }
});
