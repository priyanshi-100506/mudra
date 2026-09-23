# Page IR specification

The Page IR is MUDRA's description of a web page. It exists in two forms, and
the difference between them is the entire privacy design:

- **The internal `PageIR`** — captured in the content script, carries real
  values, never leaves the device.
- **The outbound payload** — what is actually sent, carries references.

They are different types, produced by different functions, and only one of
them has a path to the network.

---

## Internal `PageIR` — on the device only

Produced by `capturePageIR()` in `extension/src/content/perception.ts`.

```ts
interface PageIR {
  url: string;
  title: string;
  elements: PageElement[];
  text_snippets: string[];
  observed_at: string;      // ISO 8601
}

interface PageElement {
  id: string;               // observation-scoped: e1, e2, …
  role: string;             // button | textbox | link | checkbox | select | generic
  name: string;             // label, aria-label, placeholder or nearby text
  input_type?: string | null;
  autocomplete?: string | null;
  value?: string | null;          // ← the real value. Never sent.
  checked?: boolean | null;
  selected_options?: string[] | null;
  visible: boolean;
  enabled: boolean;
  bbox?: BoundingBox | null;      // CSS pixels, viewport-relative
}
```

### Capture rules

- Only visible elements. `getBoundingClientRect()` must be non-zero, computed
  `display`/`visibility`/`opacity` must not hide it, and no ancestor may be
  `aria-hidden="true"`.
- Navigation chrome is skipped — `nav`, `header`, `footer`,
  `[role="navigation"]`. It inflates the payload and a form task rarely needs
  it.
- Capped at `MAX_ELEMENTS`.
- `bbox` is **CSS pixels**. The screenshot is device pixels. See
  [architecture.md](architecture.md) on why that distinction is load-bearing.

---

## The `ref_*` token contract

When a field is sensitive, its `id` is replaced by an opaque reference and its
value is sealed into a map that never leaves the service worker.

```
ref_<6 chars of document salt><4 random chars>      e.g. ref_el05upusgd
```

### Properties

**Opaque.** Not `PASSWORD_1` or `FIELD_3`. Predictable identifiers can be
collided with by attacker-controlled page text — a page that renders the
literal string `PASSWORD_1` could confuse a planner into naming a field the
user never intended. A random handle cannot be guessed or forged from the
page.

**Stable within a document, rotating across documents.** Refs were once
regenerated on every observation, which sounded safer and was worse: the agent
re-observes before each action, so a plan built against observation *N*
carried refs that no longer existed by the time it executed. A ref that
changes under the planner's feet buys nothing, because the security property
lives in the executor's gate, not in the identifier churning.

**Meaningless outside the document.** A ref carries no information about the
field beyond what the scene graph states separately (`role`, `name`,
`sensitive`). It cannot be reversed. The `ref → value` map is held in the
service worker and is consulted only after the grant gate has approved an
action.

### What makes a field sensitive

Decided by `isSensitive()` in `extension/src/shared/redact.ts`. Identity
first, then content:

1. **Input type** — `password`, `tel`.
2. **Field name** — matches the sensitive-name pattern: password, OTP, CVV,
   PIN, Aadhaar, PAN, card number, IFSC, UPI, passport, DOB, salary, medical…
3. **Autocomplete token** — `cc-*`, `current-password`, `new-password`,
   `one-time-code`, `bday`, `tel-national`.
4. **Value** — delegated to `isPII()`, the single validated detector.

Identity is checked before content deliberately: **an empty card-number input
is still a card-number input.** A field is sensitive because of what it is,
not only because of what it currently holds.

---

## Outbound payload — what crosses the boundary

Produced by `buildOutbound()` in `extension/src/shared/redact.ts`. This shape
is the complete set of what is sent. Nothing is spread in alongside it.

```ts
interface OutboundPageIR {
  url: string;              // query params with sensitive keys/values stripped, fragment dropped
  title: string;            // run through redactSnippets
  elements: SceneElement[];
  text_snippets: string[];  // run through redactSnippets
  observed_at: string;
  screenshot_b64?: string;  // ONLY when re-OCR verification passed
}

interface SceneElement {
  ref: string;              // ref_* if sensitive, else the element id
  role: string;
  name: string;
  input_type: string | null;
  sensitive: boolean;
  bbox: BoundingBox | null;
}
```

### May appear

- Element **roles**, **names** and **types** — the planner needs to know a
  password box is a password box.
- Opaque **refs**.
- A **sensitive** flag.
- **Bounding boxes**.
- Sanitised **URL** and **title**.
- Sanitised **text snippets**.
- A **redacted screenshot**, only when verified.
- **Counts**: how many identifiers were found, faces detected, regions masked.

### May never appear

- Any element **`value`**. `SceneElement` has no `value` field at all — not a
  redacted one, not an empty one. The field does not exist.
- **`checked`** or **`selected_options`** for sensitive fields.
- A **raw screenshot**, under any failure condition.
- Any **PII string**, in any field.
- Any **canary token**.
- The **`ref → value` map**.
- **URL query parameters** whose key or value looks sensitive.
- The **URL fragment**, which is dropped outright.

### The two gates

**The no-leak assertion.** `buildOutbound` serialises the payload and checks
it against every sealed value. If one survived, it throws rather than
returning. The check covers the whole serialised body, not just the elements
array — `url`, `title` and `text_snippets` are as capable of carrying a
protected value as a field is, and this is the last point at which we can
still refuse.

**The canary scan.** Immediately before the POST, the serialised body is
searched for the three tracers planted in this observation. A hit aborts the
request and stops the session.

### The screenshot gate

`screenshot_b64` is set if and only if:

```ts
visual.reOcrVerified === true  &&  visual.screenshotB64 !== null
```

Both, not either. An image with no verification and a verification with no
image are each a bug, and neither may send anything. The field is *optional*
rather than nullable so that an absent key is the default, and every path that
would set it must first hold a verified image.

---

## Backend schema

`backend/app/schemas/page_ir.py` mirrors this, with one deliberate difference:
`PageElement.value` exists in the server model and is expected to be absent.

That is not an oversight. A redacting client sends no value, and the action
verifier treats an absent value as *unverifiable* rather than as a failure —
"Success: input executed (value withheld by client redaction; not
verifiable)". The privacy boundary working correctly must not read as the
agent failing.

The server also runs `reject_if_pii()` over every inbound observation, using
the same Verhoeff and Luhn validators as the client so a 12-digit order number
does not trip it. A rejection is a **client bug**, not a policy decision, and
the 422 says so.

---

## Worked example

A bank login page with a customer ID, a password and a PAN field.

**Internal — on the device:**

```json
{
  "url": "https://bank.example.in/login?token=a83f&next=/home#section",
  "title": "Net Banking — Meera Iyer",
  "elements": [
    { "id": "e1", "role": "textbox", "name": "Customer ID",
      "value": "CUST88214", "visible": true, "enabled": true },
    { "id": "e2", "role": "textbox", "name": "Login Password",
      "input_type": "password", "value": "hunter2", "visible": true, "enabled": true },
    { "id": "e3", "role": "textbox", "name": "PAN",
      "value": "BKPPS4321N", "visible": true, "enabled": true }
  ],
  "text_snippets": ["Welcome back, Meera"],
  "observed_at": "2026-01-01T09:14:00Z"
}
```

**Outbound — what is actually sent.** This is real output, not an
illustration; it is what `buildOutbound` produces for the input above:

```json
{
  "url": "https://bank.example.in/login?token=%5Bredacted%5D&next=%2Fhome",
  "title": "Net Banking — Meera Iyer",
  "elements": [
    { "ref": "e1", "role": "textbox", "name": "Customer ID",
      "input_type": null, "sensitive": false, "bbox": null },
    { "ref": "ref_el05upusgd", "role": "textbox", "name": "Login Password",
      "input_type": "password", "sensitive": true, "bbox": null },
    { "ref": "ref_el05upcajc", "role": "textbox", "name": "PAN",
      "input_type": null, "sensitive": true, "bbox": null }
  ],
  "text_snippets": ["Welcome back, Meera"],
  "observed_at": "2026-01-01T09:14:00Z"
}
```

Read what changed. `token=a83f` became `[redacted]` because the key matched
the sensitive-name pattern; `next=/home` survived because it did not. The
`#section` fragment is gone entirely. `hunter2` and `BKPPS4321N` are not
present in any form — not redacted, not starred, not truncated. The
`SceneElement` type has no `value` field for them to occupy.

The planner can see there is a password field and a PAN field, and can ask for
`{"action": "type", "element_id": "ref_el05upusgd", "text": "..."}`. It cannot
learn what either field holds, because neither string is anywhere in what it
received.

### What this example also shows

`"Net Banking — Meera Iyer"` went out unchanged. The name is real page
content, and MUDRA does not do named-entity recognition — `namedEntities` in
the detection counts is reported as an honest `0` rather than a plausible
number. Structured identifiers are caught by checksum; a person's name in a
page title is not, and the payload is not claimed to be free of it.
