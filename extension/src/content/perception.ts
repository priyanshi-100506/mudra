import { PageIR, PageElement, BoundingBox } from '../shared/types';

// Observation-scoped mapping from ID to live DOM node
export const currentElementMap = new Map<string, WeakRef<Element>>();

/**
 * Collects interactive elements and static snippets, returning a clean PageIR object.
 */
export function capturePageIR(): PageIR {
  currentElementMap.clear();

  let elementCounter = 1;
  const elements: PageElement[] = [];
  const textSnippets: string[] = [];

  // Extract high-level context (headings/short paragraphs)
  const headers = Array.from(document.querySelectorAll('h1, h2, h3'));
  headers.slice(0, 5).forEach((h) => {
    const text = h.textContent?.trim();
    if (text) textSnippets.push(text);
  });

  // Collect interactive candidates
  const interactiveSelector = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="textbox"]',
    '[role="combobox"]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  const candidates = Array.from(document.querySelectorAll(interactiveSelector));

  for (const el of candidates) {
    if (!isVisible(el)) continue;

    const id = `e${elementCounter++}`;
    currentElementMap.set(id, new WeakRef(el));

    const role = getElementRole(el);
    const name = getElementName(el);
    const bbox = getBoundingBox(el);

    const pageEl: PageElement = {
      id,
      role,
      name,
      visible: true,
      enabled: !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true',
      bbox
    };

    if (el instanceof HTMLInputElement) {
      pageEl.input_type = el.type || 'text';
      pageEl.value = el.value;
      if (el.type === 'checkbox' || el.type === 'radio') {
        pageEl.checked = el.checked;
      }
    } else if (el instanceof HTMLTextAreaElement) {
      pageEl.value = el.value;
    } else if (el instanceof HTMLSelectElement) {
      pageEl.selected_options = Array.from(el.selectedOptions).map((opt) => opt.value);
    }

    elements.push(pageEl);
  }

  return {
    url: window.location.href,
    title: document.title,
    elements,
    text_snippets: textSnippets,
    observed_at: new Date().toISOString()
  };
}

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;

  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
    return false;
  }

  if (el.closest('[aria-hidden="true"]')) return false;

  return true;
}

function getElementRole(el: Element): string {
  const ariaRole = el.getAttribute('role');
  if (ariaRole) return ariaRole;

  const tagName = el.tagName.toLowerCase();
  switch (tagName) {
    case 'button': return 'button';
    case 'a': return 'link';
    case 'input': return 'textbox';
    case 'select': return 'select';
    case 'textarea': return 'textbox';
    default: return 'generic';
  }
}

function getElementName(el: Element): string {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();

  if (el.id) {
    const escapedId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id.replace(/(["\\])/g, '\\$1');
    const labelEl = document.querySelector(`label[for="${escapedId}"]`);
    if (labelEl && labelEl.textContent) return labelEl.textContent.trim();
  }

  const alt = el.getAttribute('alt');
  if (alt) return alt.trim();

  const title = el.getAttribute('title');
  if (title) return title.trim();

  const placeholder = el.getAttribute('placeholder');
  if (placeholder) return placeholder.trim();

  const visibleText = el.textContent?.trim();
  if (visibleText) return visibleText.slice(0, 50);

  return '';
}

function getBoundingBox(el: Element): BoundingBox {
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}