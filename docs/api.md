# CLIO Backend — API Reference

> Base URL (local dev): `http://127.0.0.1:8000`
> Auth: none — CORS is open to `*`. All sessions are keyed by a client-supplied UUID.

---

## Endpoints

### `GET /health`

Liveness probe. Returns whether the Gemini API key is configured.

**Response `200`**
```json
{ "status": "ok", "gemini_configured": true }
```

---

### `GET /test`

Returns a self-contained HTML test page (`test_page.html`) that can be used to drive the agent against a known form without installing the extension.

**Response `200`** — `text/html`

---

### `POST /agent/step`

The main agentic step. Accepts the current page state, plans the next action via Gemini, and returns it to the caller.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `goal` | `string` | ✅ | The natural-language task the agent is trying to complete |
| `page_ir` | `PageIR` | ✅ | Current snapshot of the page (see [PageIR spec](./page_ir_spec.md)) |
| `session_id` | `string` | | Client-generated UUID. Defaults to `"default"`. Used to persist step history |

**Example request**
```json
{
  "goal": "Fill in the contact form and submit it",
  "session_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "page_ir": {
    "url": "https://example.com/contact",
    "title": "Contact Us",
    "observed_at": "2026-09-06T08:00:00Z",
    "text_snippets": ["Get in touch"],
    "elements": [
      { "id": "e1", "role": "textbox", "name": "Your Name",  "input_type": "text",  "value": "", "visible": true, "enabled": true },
      { "id": "e2", "role": "textbox", "name": "Email",      "input_type": "email", "value": "", "visible": true, "enabled": true },
      { "id": "e3", "role": "button",  "name": "Send",       "visible": true, "enabled": true }
    ]
  }
}
```

**Response `200` — `LoopStepResponse`**

| Field | Type | Description |
|---|---|---|
| `action` | `AgentAction` | The action object to execute (see [action schema](./action_schema.md)) |
| `status` | `"continue"` \| `"done"` \| `"error"` | Loop state after this step |
| `message` | `string` | Human-readable description of the action or error |
| `extracted_data` | `string \| null` | Set only when an `extract` action resolved data |

**Example response**
```json
{
  "action": { "action": "type", "element_id": "e1", "text": "Alice" },
  "status": "continue",
  "message": "Action planned: type(e1, \"Alice\")",
  "extracted_data": null
}
```

**Error responses**

| Code | Cause |
|---|---|
| `422` | `page_ir` failed Pydantic validation (missing required fields, wrong types) |
| `500` | Gemini API unreachable and all fallback models exhausted |

---

### `POST /agent/reset`

Clears the step history and retry counter for a session so a new task can begin on the same `session_id`.

**Request body**
```json
{ "session_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479" }
```

**Response `200`**
```json
{ "status": "reset", "session_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479" }
```

---

### `GET /agent/status/{session_id}`

Returns metadata for an active session.

**Response `200`**
```json
{
  "session_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "steps": 4,
  "retry_count": 0,
  "last_result": "success"
}
```

For an unknown `session_id`:
```json
{ "session_id": "unknown", "steps": 0, "active": false }
```

---

## curl Quick-Reference

```bash
# Health check
curl http://127.0.0.1:8000/health

# Single agent step
curl -s -X POST http://127.0.0.1:8000/agent/step \
  -H 'Content-Type: application/json' \
  -d '{
    "goal": "Click the login button",
    "session_id": "demo-session",
    "page_ir": {
      "url": "https://example.com",
      "title": "Example",
      "observed_at": "2026-09-06T08:00:00Z",
      "text_snippets": [],
      "elements": [
        {"id":"e1","role":"button","name":"Login","visible":true,"enabled":true}
      ]
    }
  }' | python -m json.tool

# Reset session
curl -s -X POST http://127.0.0.1:8000/agent/reset \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"demo-session"}' | python -m json.tool
```
