import { currentElementMap } from './perception';
export class StaleElementError extends Error {
    constructor(elementId) {
        super(`Element ${elementId} is stale or no longer connected to the DOM.`);
        this.name = 'StaleElementError';
    }
}
/**
 * Resolves an element ID from the current perception snapshot to a live attached DOM node.
 */
function getLiveElement(id) {
    const ref = currentElementMap.get(id);
    const el = ref?.deref();
    if (!el || !el.isConnected) {
        throw new StaleElementError(id);
    }
    return el;
}
/**
 * Safely executes a single AgentAction on the DOM.
 */
export async function executeAction(action) {
    try {
        switch (action.action) {
            case 'click': {
                const el = getLiveElement(action.element_id);
                el.scrollIntoView({ block: 'center', inline: 'nearest' });
                el.click();
                return { success: true };
            }
            case 'type': {
                const el = getLiveElement(action.element_id);
                el.scrollIntoView({ block: 'center', inline: 'nearest' });
                el.focus();
                el.value = action.text;
                // Dispatch synthetic events so framework-bound inputs (React/Vue/Angular) register the change
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { success: true };
            }
            case 'select': {
                const el = getLiveElement(action.element_id);
                el.scrollIntoView({ block: 'center', inline: 'nearest' });
                el.value = action.option;
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { success: true };
            }
            case 'scroll': {
                const delta = action.direction === 'down' ? action.amount : -action.amount;
                window.scrollBy({ top: delta, behavior: 'smooth' });
                return { success: true };
            }
            case 'navigate': {
                window.location.href = action.url;
                return { success: true };
            }
            case 'wait': {
                await new Promise((resolve) => setTimeout(resolve, action.duration_ms));
                return { success: true };
            }
            case 'extract': {
                const el = getLiveElement(action.element_id);
                const text = el.textContent?.trim() || el.value || '';
                return { success: true, extracted_data: text };
            }
            case 'done': {
                return { success: true };
            }
            default:
                return { success: false, error: 'Unknown action type' };
        }
    }
    catch (err) {
        return {
            success: false,
            error: err.message || 'Execution failed'
        };
    }
}
