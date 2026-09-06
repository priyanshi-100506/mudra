# PageIR Specification

`PageIR` (Page Intermediate Representation) is the structured snapshot of the current browser page sent from the extension to the backend on every agent step. It is designed to be compact, deterministic, and free of raw sensitive values.

---

## `PageIR`

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | `string` | ✅ | Full `window.location.href` at observation time |
| `title` | `string` | ✅ | `document.title` |
| `elements` | `PageElement[]` | ✅ | Flat, ordered list of interactive elements (see below) |
| `text_snippets` | `string[]` | ✅ | Up to 5 top-level headings extracted from `<h1>`–`<h3>` tags, providing page context |
| `observed_at` | `string` | ✅ | ISO 8601 timestamp of when the snapshot was captured |

**Example**
```json
{
  "url": "https://bank.example.com/transfer",
  "title": "Transfer Funds",
  "observed_at": "2026-09-06T08:00:00.000Z",
  "text_snippets": ["Transfer Funds", "Move money between accounts"],
  "elements": [ ... ]
}
```

---

## `PageElement`

Represents one interactive element on the page.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | ✅ | Observation-scoped unique identifier, e.g. `"e1"`, `"e2"`. Stable within one `PageIR`; regenerated each observation |
| `role` | `string` | ✅ | ARIA or inferred role: `button`, `textbox`, `link`, `checkbox`, `select`, `combobox`, `generic` |
| `name` | `string` | ✅ | Resolved accessible name (label text, `aria-label`, etc.) |
| `input_type` | `string \| null` | | HTML `<input type="…">` value if applicable, e.g. `"text"`, `"email"`, `"password"` |
| `value` | `string \| null` | | Current text value of an input or textarea. May be omitted for sensitive fields |
| `checked` | `boolean \| null` | | Checked state for checkbox or radio inputs |
| `selected_options` | `string[] \| null` | | Currently selected option values for `<select>` elements |
| `visible` | `boolean` | ✅ | `true` if the element passes visibility heuristics (non-zero rect, not hidden) |
| `enabled` | `boolean` | ✅ | `true` if the element is interactive (not `disabled`, not `aria-disabled`) |
| `bbox` | `BoundingBox \| null` | | Viewport-relative bounding box in CSS pixels |

### `BoundingBox`

```json
{ "x": 120, "y": 340, "width": 300, "height": 44 }
```

| Field | Type | Description |
|---|---|---|
| `x` | `float` | Left edge, CSS pixels from viewport left |
| `y` | `float` | Top edge, CSS pixels from viewport top |
| `width` | `float` | Element width in CSS pixels |
| `height` | `float` | Element height in CSS pixels |

---

## Accessible-Name Resolution Order

The content script resolves `name` using this priority order (mirrors ARIA specification):

1. `aria-label` attribute
2. `aria-labelledby` — concatenates referenced element text
3. Wrapping `<label>` element text
4. `<label for="…">` association via `id`
5. Table-cell lookup — walks left across siblings, then to the row's first cell
6. Element's own text content (buttons, links label themselves)
7. Label-like preceding sibling (`<label>`, `<span>`, `<td>`, `<dt>`, etc.)
8. `alt` attribute (images)
9. `title` attribute
10. `placeholder` attribute
11. Humanised `name` or `id` attribute (underscores/hyphens → spaces)

---

## Element Cap and Ordering

- **Maximum 60 elements** per `PageIR` to bound token usage.
- **Sensitive fields are hoisted first** in the candidate list before the cap is applied, ensuring that password inputs, card number fields, etc. are never dropped if the page has many elements.
- Navigation chrome (`<nav>`, `<header>`, `<footer>`, `[role="navigation"]`) is excluded to keep the IR focused on task-relevant elements.

---

## Privacy Invariant

The content script collects `value` from every input it observes. The Mudra redaction layer in the extension (`redact.ts`) replaces values of sensitive fields with opaque `ref_` handles before the payload is sent. From the backend's perspective, a sensitive field's `value` will be `null` or absent — the backend must plan around `name`, `role`, and `input_type` alone for those fields.

The backend must **never** attempt to reconstruct or log raw values from the PageIR.
