import { capturePageIR } from './perception';
import { executeAction } from './executor';
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'CAPTURE_PAGE_IR') {
        const pageIR = capturePageIR();
        chrome.runtime.sendMessage({
            type: 'PAGE_IR_CAPTURED',
            pageIR,
        });
        sendResponse({ success: true });
    }
    else if (message.type === 'EXECUTE_ACTION') {
        executeAction(message.action).then((result) => {
            sendResponse(result);
        });
        return true; // Asynchronous response signal
    }
});
