from typing import List, Optional
from pydantic import BaseModel, Field


class BoundingBox(BaseModel):
    x: float
    y: float
    width: float
    height: float


class PageElement(BaseModel):
    """
    One interactive element in the page snapshot.

    For ordinary fields, `ref` equals the observation-scoped element id (e.g. "e1").
    For sensitive fields the Mudra redaction layer replaces `ref` with a
    request-scoped random handle (e.g. "ref_1k4z") and strips value/checked/
    selected_options entirely — the backend must plan using name/role/input_type
    and sensitive flag alone for those fields.
    """
    ref: str = Field(description="Observation-scoped unique handle. Opaque ref_* for sensitive fields.")
    role: str = Field(description="Role like button, textbox, link, checkbox, select, generic")
    name: str = Field(description="Extracted accessible label of the element")
    input_type: Optional[str] = Field(default=None, description="HTML input type if applicable (e.g. email, password)")
    autocomplete: Optional[str] = Field(default=None, description="HTML autocomplete token, if present")
    sensitive: bool = Field(default=False, description="True when the field holds private data redacted client-side")
    # value / checked / selected_options are intentionally absent:
    # sensitive fields never carry values; the backend must not depend on them.
    visible: bool = Field(default=True, description="Whether the element passes visibility heuristics")
    enabled: bool = Field(default=True, description="Whether the element is interactive and not disabled")
    bbox: Optional[BoundingBox] = Field(default=None, description="Viewport coordinates of element")


class PageIR(BaseModel):
    url: str = Field(description="Current window location URL")
    title: str = Field(description="Current document title")
    elements: List[PageElement] = Field(default_factory=list, description="Flat list of interactive elements")
    text_snippets: List[str] = Field(default_factory=list, description="Top-level static context headings/snippets")
    observed_at: str = Field(description="ISO timestamp of observation")