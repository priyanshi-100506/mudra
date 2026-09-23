# Action schema

What the planner is allowed to ask for, and what the device is willing to do
about it.

The planner proposes. It never acts. Every action it returns is checked
locally against a grant the user authorised before the page was ever read,
and then revalidated against the live DOM immediately before it runs.

---

## The verbs

Nine actions exist in the schema. Six of them are ordinary interaction; three
are structural.

| Action | Shape | Effect name |
|---|---|---|
| `click` | `{action, element_id}` | `click` |
| `type` | `{action, element_id, text}` | `set_public_text` |
| `select` | `{action, element_id, option}` | `select` |
| `scroll` | `{action, direction, amount}` | `scroll` |
| `navigate` | `{action, url}` | `navigate_cross_origin` |
| `wait` | `{action, duration_ms}` | `wait` |
| `extract` | `{action, element_id}` | `extract` |
| `submit` | `{action, element_id}` | `submit_form` |
| `done` | `{action, summary}` | `done` |

Defined in `backend/app/schemas/actions.py` and mirrored in
`extension/src/shared/types.ts`.

Note that `type` maps to the effect `set_public_text`. The name is the point:
the planner can put text into a field, and the text is its own. It cannot ask
for a *protected* value to be typed, because it never received one — a sealed
field's contents are not in the payload at all, so there is nothing for the
planner to echo back.

### Validation

Enforced by Pydantic on the way in, so a malformed plan is a 422 rather than
a runtime surprise:

| Field | Rule |
|---|---|
| `text` | at most 2000 characters |
| `amount` (scroll) | integer, 0–5000 |
| `duration_ms` | integer, 0–10000 |
| `direction` | exactly `"up"` or `"down"` |
| `element_id` | must exist in the current Page IR |
| `action` | must be one of the nine literals |

`element_id` is checked twice, and the second check is the one that matters.
The planner may only name ids present in the observation it was given. The
executor then resolves that id through the node registry and revalidates
**identity, epoch, connectedness, origin and role** against the live DOM
before touching anything. An id that resolved a moment ago but now points at a
different element — because the page re-rendered, or because the page is
hostile — fails there.

---

## Grants

A grant is a local, task- and origin-scoped authorisation. It is **derived on
the device** from the task the user typed and the origin they are on. The
server never mints one, never sees one, and cannot widen one.

```ts
interface Grant {
  task: string;            // login | form_fill | read_only
  origin: string;          // the origin it was issued for
  allowedEffects: string[];
  maxUses: number;
  usesRemaining: number;
  authorised: boolean;     // set once, by the user, before any observation
}
```

### What each task template permits

Base effects, always available: `click`, `set_public_text`, `select`,
`scroll`, `wait`, `extract`, `done`.

| Task | Triggered by | Adds | Uses |
|---|---|---|---|
| `login` | "log in", "sign in" | `set_secret`, `submit_form` | 1 |
| `form_fill` | "fill", "form", "apply" | `submit_form` | 1 |
| `read_only` | anything else | — | 0 |

`read_only` is the default, and it is the default on purpose: a task whose
wording does not clearly ask to change something does not get permission to
change something.

### High-impact effects

These require explicit authorisation and consume a use:

```
submit_form   navigate_cross_origin   transfer
purchase      delete                  upload       set_secret
```

---

## The gate

`checkAction(action, grant, currentOrigin)` in
`extension/src/shared/grant.ts`. Every side-effecting action passes through
it. It fails closed: anything unmatched is refused.

The checks, in order:

1. **No grant** → refuse. Nothing runs without one.
2. **Origin changed** → refuse. A grant issued for `bank.example` does not
   travel to `attacker.example`, even mid-task. This is the defence against a
   page that navigates under the agent.
3. **Effect not in `allowedEffects`** → refuse, naming the effect.
4. **High-impact and not authorised** → refuse. Note: *refuse*, not prompt.
5. **High-impact and uses exhausted** → refuse. One authorisation, one use.
6. Otherwise allow, consuming a use if high-impact.

### Reading the action, not the label

A click is not inherently high-impact — `click` is in every grant's base
effects, because an agent that needs confirmation to click a tab is useless.
But *what a click lands on* decides what it does, and that is checked in two
independent layers.

**Layer 1 — the control's label.** A button reading `Transfer ₹50,000` yields
the effect `transfer`, not `click`.

**Layer 2 — the form's shape.** The page chooses its own button text, so
layer 1 defeats only honest labels. A button reading `Continue` over a form
that posts `amount`, `payee_account` and `ifsc` to `/funds/transfer` is a
transfer whatever it calls itself. The effect is derived from the form's
field names, its action path, and whether it posts cross-origin.

Field **names** only, never values. Recognising a payment-shaped form needs
"there is a field called amount" and nothing more.

Both layers can only ever *raise* the required permission. The worst a
hostile page achieves by manipulating its own labels or form is making MUDRA
ask for a confirmation it did not strictly need.

#### The two answers, and why they differ

| What revealed it | Verdict | Why |
|---|---|---|
| The control's own label | **refuse** | The planner asked for something plainly outside the task. Nothing ambiguous to resolve. |
| Only the form's shape | **confirm** | It may genuinely be the payment the user is trying to make. Refusing every unclassifiable form would make the agent useless on real sites; allowing it silently would trust a page that chooses its own labels. So a person decides. |

A `confirm` verdict consumes a use exactly as an authorised high-impact
effect does, and a declined confirmation is recorded as a refusal.

#### The limit, stated plainly

**A button with no form, whose effect happens in page JavaScript, cannot be
classified from the DOM.** A `<button onclick="transferFunds()">Continue</button>`
looks identical to a button that opens a menu. Neither layer sees anything.

Nothing in the DOM can close that gap, because the effect does not exist in
the DOM. What covers it is the confirmation on consequential actions and the
fact that a grant is scoped to one task on one origin with a finite number of
high-impact uses — a script-driven action still cannot exceed what the user
authorised for the task, and cannot run twice.

### Why refusing beats prompting

`authorised` is set once, by the user, **before the page is ever observed**,
and the dialog names the effects it covers. An unauthorised grant refuses
rather than prompting mid-task.

This ordering is deliberate. A prompt that appears *during* a task, after the
agent has read the page and formed a plan, is a prompt the user is primed to
accept — they asked for the task, something is now asking to continue it, and
the pressure is entirely toward yes. Asking first, in the quiet, about a task
rather than about a step, is a question the user can actually answer.

It also closes a real hole: a task that somehow skipped the dialog cannot
quietly proceed by triggering a prompt it would probably be granted.

---

## What the planner cannot do

Not by policy — by construction. There is no message it can send that achieves
these:

- **Read a protected value.** Sealed fields are `ref_*` handles with no value
  attached. The payload has no `value` field at all.
- **Name an element that does not exist.** The registry resolves ids issued in
  the current observation; refs rotate when the document changes.
- **Act on a different origin than it was granted.** Checked at the gate and
  again at the executor.
- **Escalate its own grant.** Grants are derived locally from the user's
  typed task. Nothing in a planner response is read as permission.
- **Perform a high-impact effect twice.** `usesRemaining` is decremented
  locally.
- **Cause a raw screenshot to be sent.** The image gate is
  `reOcrVerified && screenshotB64`, and neither is planner-controlled.

---

## Refusals are recorded

Every refusal is written to the manifest with its effect and reason, and
surfaced in the panel with the refusal count. A gate that silently declines is
indistinguishable from a gate that was never reached.

The stub planner is worth a note here: only its *choosing* is stubbed.
Everything it emits goes through the same grant check, the same confirmation
dialog and the same executor as a Gemini plan, and a test validates every
action it produces against the real schema. The refusal path in a demo is not
mocked — only the hostile plan that provokes it.
