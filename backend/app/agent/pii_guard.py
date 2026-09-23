"""Server-side PII tripwire.

Defence in depth, and nothing more. The client redacts; that is where the
security property lives, because it is the only place that ever holds the raw
values. This module exists so that a client bug is loud rather than silent.

If it ever fires in production, the correct reading is not "the server saved
us" — by then the value has already crossed the network and been logged by
whatever sits in between. The correct reading is "the extension has a bug that
must be fixed", which is exactly why the rejection is an error and not a
quiet scrub.

The validators mirror extension/src/content/redaction.ts deliberately, so that
a 12-digit order number fails the Verhoeff check here too and does not produce
a spurious rejection of a perfectly clean payload.
"""

import re
from typing import Iterator, Optional

_VERHOEFF_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]

_VERHOEFF_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]


def is_valid_verhoeff(digits: str) -> bool:
    if not digits.isdigit():
        return False
    c = 0
    for i, ch in enumerate(reversed(digits)):
        c = _VERHOEFF_D[c][_VERHOEFF_P[i % 8][int(ch)]]
    return c == 0


def is_aadhaar(value: str) -> bool:
    digits = re.sub(r"\s+", "", value)
    if not re.fullmatch(r"\d{12}", digits):
        return False
    if digits[0] in "01":
        return False
    return is_valid_verhoeff(digits)


def is_valid_luhn(value: str) -> bool:
    digits = re.sub(r"[\s-]", "", value)
    if not re.fullmatch(r"\d{13,19}", digits):
        return False
    total = 0
    double = False
    for ch in reversed(digits):
        d = int(ch)
        if double:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        double = not double
    return total % 10 == 0


# (label, search pattern, optional structural validator)
_PATTERNS = [
    ("AADHAAR", re.compile(r"\b\d{4}\s?\d{4}\s?\d{4}\b"), is_aadhaar),
    ("CARD", re.compile(r"\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{1,7}\b"), is_valid_luhn),
    ("PAN", re.compile(r"\b[A-Z]{5}[0-9]{4}[A-Z]\b"), None),
    ("IFSC", re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b"), None),
    (
        "UPI_VPA",
        re.compile(
            r"\b[\w.\-]{2,}@(?:ok(?:hdfcbank|icici|axis|sbi)|paytm|ybl|upi|apl|ibl|axl)\b",
            re.I,
        ),
        None,
    ),
    ("EMAIL", re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"), None),
    ("PASSPORT_IN", re.compile(r"\b[A-Z][1-9][0-9]{6}\b"), None),
]


def find_pii(text: str) -> Optional[str]:
    """Returns the *label* of the first PII found, or None.

    The label, never the value. A guard that logged the number it caught
    would have written the leak into a second place, and this code path is
    reached precisely when something has already gone wrong.
    """
    if not text:
        return None
    for label, pattern, validator in _PATTERNS:
        for match in pattern.finditer(text):
            if validator is None or validator(match.group()):
                return label
    return None


def _text_fields(page_ir) -> Iterator[tuple[str, str]]:
    """Every free-text field a value could ride in on."""
    yield "url", getattr(page_ir, "url", "") or ""
    yield "title", getattr(page_ir, "title", "") or ""
    for i, snippet in enumerate(getattr(page_ir, "text_snippets", None) or []):
        yield f"text_snippets[{i}]", snippet or ""
    for el in getattr(page_ir, "elements", None) or []:
        for attr in ("name", "value"):
            value = getattr(el, attr, None)
            if value:
                yield f"elements[{getattr(el, 'id', '?')}].{attr}", value
        for opt in getattr(el, "selected_options", None) or []:
            yield f"elements[{getattr(el, 'id', '?')}].selected_options", opt


def assert_no_pii(page_ir) -> None:
    """Raises ValueError naming the field and the kind, never the value.

    The client should never send one of these. A rejection therefore means a
    client bug, which is the thing worth catching.
    """
    for field, text in _text_fields(page_ir):
        label = find_pii(text)
        if label:
            raise ValueError(
                f"Rejected: a {label} value reached the server in '{field}'. "
                "The client redactor should have sealed this into a reference; "
                "this is a client bug, not a server policy decision."
            )
