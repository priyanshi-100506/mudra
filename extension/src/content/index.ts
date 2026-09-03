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