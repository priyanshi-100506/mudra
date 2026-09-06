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

  const MAX_ELEMENTS = 60;

  /** Cheap pre-check so sensitive fields are never crowded out by the cap. */
  const looksSensitive = (el: Element): boolean => {
    if (el instanceof HTMLInputElement && el.type === 'password') return true;
    const hay = [
      el.getAttribute('name') ?? '',
      el.id ?? '',
      el.getAttribute('autocomplete') ?? '',
      el.getAttribute('placeholder') ?? '',
    ].join(' ');
    return /(pass|pwd|otp|cvv|cvc|pin|card|aadhaar|aadhar|\bpan\b|ssn|social|licen|passport|account|ifsc|upi|expir|dob|birth)/i.test(hay);
  };
  const raw = Array.from(document.querySelectorAll(interactiveSelector));
  // Sensitive-looking fields first so the cap never hides the ones that matter.
  const candidates = [...raw.filter(looksSensitive), ...raw.filter((e) => !looksSensitive(e))];

  for (const el of candidates) {
    if (elements.length >= MAX_ELEMENTS) break;
    if (!isVisible(el)) continue;

    // Skip navigation chrome — it inflates the payload and the planner
    // rarely needs it for a form task.
    if (el.closest('nav, header, footer, [role="navigation"]')) continue;

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
      pageEl.autocomplete = el.getAttribute('autocomplete');
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

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/[:*]\s*$/, '').trim().slice(0, 60);
}

function getElementName(el: Element): string {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .filter(Boolean);
    if (parts.length) return clean(parts.join(' '));
  }

  const wrapping = el.closest('label');
  if (wrapping?.textContent) {
    const t = clean(wrapping.textContent);
    if (t) return t;
  }

  // table forms: walk left across cells, then up to the row's first cell
  const cell = el.closest('td, th');
  if (cell) {
    let prev = cell.previousElementSibling;
    while (prev) {
      const t = clean(prev.textContent ?? '');
      if (t && !/^\s*$/.test(t)) return t;
      prev = prev.previousElementSibling;
    }
    const row = cell.closest('tr');
    const firstCell = row?.querySelector('td, th');
    if (firstCell && firstCell !== cell) {
      const t = clean(firstCell.textContent ?? '');
      if (t) return t;
    }
  }

  // An element's own text is its name — buttons and links label themselves.
  const ownText = clean(el.textContent ?? '');
  if (ownText) return ownText;

  // Generic layouts: a preceding sibling may be the label, but only if it
  // looks like one. Headings and prose are page structure, not field labels.
  const LABELISH = new Set(['LABEL', 'SPAN', 'TD', 'TH', 'DT', 'STRONG', 'B', 'P']);
  let node: Element | null = el;
  for (let depth = 0; node && depth < 2; depth++) {
    let sib = node.previousElementSibling;
    while (sib) {
      if (LABELISH.has(sib.tagName) && !sib.querySelector('input, select, textarea, button')) {
        const t = clean(sib.textContent ?? '');
        if (t && t.length < 60) return t;
      }
      sib = sib.previousElementSibling;
    }
    node = node.parentElement;
  }

  if (el.id) {
    const escapedId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id.replace(/(["\\])/g, '\\$1');
    const labelEl = document.querySelector(`label[for="${escapedId}"]`);
    if (labelEl && labelEl.textContent) return labelEl.textContent.trim();
  }

  const alt = el.getAttribute('alt');
  if (alt) return clean(alt);

  const title = el.getAttribute('title');
  if (title) return clean(title);

  const placeholder = el.getAttribute('placeholder');
  if (placeholder) return clean(placeholder);

  // last resort: the name or id attribute, humanised
  const attr = el.getAttribute('name') || el.id;
  if (attr) return clean(attr.replace(/[_\-.]+/g, ' '));

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