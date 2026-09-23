"""A deterministic planner that needs no key and no network.

This is the demo's safety net, so it is built to be genuinely capable rather
than to prove the wiring works. If Ollama misbehaves on stage — a cold model,
a CORS rejection, a laptop that decided to swap — this has to carry a complete
multi-step task in front of an audience without anyone being told to squint.

So it *reads the page* rather than replaying a fixed script. It fills the
fields a form actually has, in the order they appear, skips the ones the
client sealed, and submits when there is nothing left to fill. Against an
unfamiliar fixture it behaves sensibly instead of walking off the end of a
canned list, which is exactly the failure a scripted stub has in front of
people.

What it deliberately does *not* do is make anything up about the security
path. Every action it emits goes through the same grant check, the same
confirmation dialog and the same executor as a Gemini plan. Only the choosing
is stubbed.
"""

from typing import Any, Dict, List, Optional

from app.schemas.page_ir import PageIR, PageElement

# Plausible values for the field kinds our fixtures use. Synthetic throughout:
# a stub that typed a real-looking identifier into a demo would undercut the
# thing being demonstrated.
_FILL_BY_NAME: List[tuple[tuple[str, ...], str]] = [
    (("customer id", "customer_id", "user id", "username"), "demo-user"),
    (("full name", "name as on", "applicant name", "your name"), "Asha Verma"),
    (("email",), "asha.verma@example.test"),
    (("mobile", "phone"), "9000000000"),
    (("amount",), "2500"),
    (("assessment year", "year"), "2025-26"),
    (("city", "town"), "Bengaluru"),
    (("pincode", "pin code", "postal"), "560001"),
    (("search", "query"), "account statement"),
]

_DEFAULT_FILL = "demo value"

# Roles the stub is willing to type into.
_TEXTUAL = {"textbox", "searchbox", "combobox"}


def _fill_for(element: PageElement) -> str:
    name = (element.name or "").lower()
    for keys, value in _FILL_BY_NAME:
        if any(k in name for k in keys):
            return value
    return _DEFAULT_FILL


def _is_sealed(element: PageElement) -> bool:
    """True when the client sealed this field into a reference.

    A sealed field's id is an opaque ref and its value never arrives, so the
    stub has nothing to type and no business trying. Leaving these alone is
    also the honest demo: the agent works around protected fields rather than
    through them.
    """
    return element.value is None and (element.input_type in {"password", "tel"})


def _already_acted_on(history: List[Dict[str, Any]], element_id: str) -> bool:
    for entry in history:
        action = entry.get("action") or {}
        if action.get("element_id") == element_id:
            return True
    return False


def _looks_submitted(history: List[Dict[str, Any]]) -> bool:
    return any((e.get("action") or {}).get("action") == "submit" for e in history)


def plan(
    goal: str,
    page_ir: PageIR,
    history: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Chooses one action, in the same schema a real planner must produce."""
    history = history or []

    if _looks_submitted(history):
        return {
            "action": "done",
            "summary": (
                f"Completed '{goal}'. The form was filled and submitted. "
                "Protected fields were left to you — the planner never saw their values."
            ),
        }

    elements = [e for e in page_ir.elements if e.visible and e.enabled]

    # 1. Fill the next empty, unsealed text field we have not touched.
    for element in elements:
        if element.role not in _TEXTUAL:
            continue
        if _is_sealed(element):
            continue
        if _already_acted_on(history, element.id):
            continue
        if (element.value or "").strip():
            continue  # already has content
        return {"action": "type", "element_id": element.id, "text": _fill_for(element)}

    # 2. Make any untouched dropdown choice.
    for element in elements:
        if element.role == "select" and not _already_acted_on(history, element.id):
            options = element.selected_options or []
            if options:
                return {"action": "select", "element_id": element.id, "option": options[0]}

    # 3. Commit. This is high-impact: the client will ask before it runs.
    for element in elements:
        if element.role == "button":
            return {"action": "submit", "element_id": element.id}

    # 4. Nothing actionable on this page.
    return {
        "action": "done",
        "summary": (
            f"Nothing left to do for '{goal}' on this page: no fillable fields "
            "and no submit control were found."
        ),
    }
