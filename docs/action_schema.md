# Action Schema

CLIO's backend plans exactly **one action per step**. Every response to `POST /agent/step` carries a single action object in the `action` field.

---

## Discriminated Union

All actions share the `action` discriminator field. Pydantic uses it to route validation to the correct model. Unknown values cause a `422`.

```
action ∈ { "click" | "type" | "select" | "scroll" | "navigate" | "wait" | "extract" | "done" }
```

---

## Action Types

### `click`

Simulates a left-click on an interactive element.

```json
{ "action": "click", "element_id": "e3" }
```

| Field | Type | Description |
|---|---|---|
| `element_id` | `string` | Target element `id` from the current PageIR |

**Verifier:** passes if the URL changed or the page element count changed after execution. Otherwise passes unconditionally (click may have no visible DOM effect).

---

### `type`

Inserts text into a text input or textarea. The content script clears the field then sets its value.

```json
{ "action": "type", "element_id": "e1", "text": "alice@example.com" }
```

| Field | Type | Constraints | Description |
|---|---|---|---|
| `element_id` | `string` | | Target input element `id` |
| `text` | `string` | max 2 000 chars | Text to insert |

**Verifier:** passes if `after_ir[element_id].value == text`.

> **Sensitive fields:** For fields the Mudra layer has redacted, the extension injects the real value client-side using the `refMap` and ignores the `text` payload. The planner should still emit a `type` action; the `text` may be a placeholder.

---

### `select`

Selects an option in a `<select>` dropdown.

```json
{ "action": "select", "element_id": "e4", "option": "India" }
```

| Field | Type | Description |
|---|---|---|
| `element_id` | `string` | Target `<select>` element `id` |
| `option` | `string` | The option value or label to select |

**Verifier:** passes if `option ∈ after_ir[element_id].selected_options`.

---

### `scroll`

Scrolls the page to reveal off-screen content.

```json
{ "action": "scroll", "direction": "down", "amount": 400 }
```

| Field | Type | Constraints | Default | Description |
|---|---|---|---|---|
| `direction` | `"up" \| "down"` | | | Scroll direction |
| `amount` | `integer` | 0–5 000 px | `400` | Pixels to scroll |

**Verifier:** always passes.

---

### `navigate`

Navigates the active tab to a new URL. The service worker waits for `tabs.onUpdated` status `"complete"` before the next observation.

```json
{ "action": "navigate", "url": "https://example.com/dashboard" }
```

| Field | Type | Description |
|---|---|---|
| `url` | `string` | Full absolute URL |

**Verifier:** passes if `after_ir.url ≠ before_ir.url`.

---

### `wait`

Pauses execution for a specified duration. The backend sleeps for the full `duration_ms` before returning the response, so the extension receives the response only after the wait completes.

```json
{ "action": "wait", "duration_ms": 2000 }
```

| Field | Type | Constraints | Default | Description |
|---|---|---|---|---|
| `duration_ms` | `integer` | 0–10 000 ms | `1 000` | Duration to wait |

**Verifier:** always passes.

---

### `extract`

Reads the textual content of an element and returns it in `extracted_data`. Use this to retrieve dynamic page data (order numbers, confirmation codes, etc.).

```json
{ "action": "extract", "element_id": "e7" }
```

| Field | Type | Description |
|---|---|---|
| `element_id` | `string` | Target element `id` |

**Verifier:** always passes.

---

### `done`

Terminal action. Signals that the goal has been fully accomplished (or cannot be accomplished). Sets `status: "done"` on the response.

```json
{ "action": "done", "summary": "Successfully submitted the contact form." }
```

| Field | Type | Description |
|---|---|---|
| `summary` | `string` | Human-readable explanation of what was accomplished or why the goal cannot be completed |

**Verifier:** always passes.

---

## Element ID Validation

Before executing any element-targeting action (`click`, `type`, `select`, `extract`), the `AgentLoop` verifies that `element_id` exists in the current `PageIR.elements` list. If not, the response is:

```json
{
  "action": { "action": "click", "element_id": "e999" },
  "status": "error",
  "message": "Error: element_id 'e999' does not exist in current Page IR."
}
```

The extension surfaces this as a warning and retries the observation.
