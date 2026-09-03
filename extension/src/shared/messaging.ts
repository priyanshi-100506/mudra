import { AgentAction, PageIR } from './types';

export type ExtensionMessage =
  | { type: 'START_TASK'; goal: string }
  | { type: 'STOP_TASK' }
  | { type: 'CAPTURE_PAGE_IR' }
  | { type: 'PAGE_IR_CAPTURED'; pageIR: PageIR }
  | { type: 'EXECUTE_ACTION'; action: AgentAction }
  | { type: 'ACTION_EXECUTED'; success: boolean; error?: string; extracted_data?: string }
  | { type: 'TASK_STATUS'; status: 'idle' | 'running' | 'completed' | 'error'; message: string };

export function sendMessageToTab(tabId: number, message: ExtensionMessage): Promise<any> {
  return chrome.tabs.sendMessage(tabId, message);
}

export function sendMessageToRuntime(message: ExtensionMessage): Promise<any> {
  return chrome.runtime.sendMessage(message);
}