export function sendMessageToTab(tabId, message) {
    return chrome.tabs.sendMessage(tabId, message);
}
export function sendMessageToRuntime(message) {
    return chrome.runtime.sendMessage(message);
}
