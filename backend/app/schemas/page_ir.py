from typing import List, Optional
from pydantic import BaseModel, Field


class BoundingBox(BaseModel):
    x: float
    y: float
    width: float
    height: float


class PageElement(BaseModel):
    id: str = Field(description="Observation-scoped unique identifier (e.g., e1, e2)")
    role: str = Field(description="Role like button, textbox, link, checkbox, select, generic")
    name: str = Field(description="Extracted label or title of the element")
    input_type: Optional[str] = Field(default=None, description="HTML input type if applicable (e.g., email, password)")
    value: Optional[str] = Field(default=None, description="Current text value of input or select")
    checked: Optional[bool] = Field(default=None, description="Checked state for checkboxes/radios")
    selected_options: Optional[List[str]] = Field(default=None, description="Currently selected options in dropdowns")
    visible: bool = Field(default=True, description="Whether the element passes visibility heuristics")
    enabled: bool = Field(default=True, description="Whether the element is interactive and not disabled")
    bbox: Optional[BoundingBox] = Field(default=None, description="Viewport coordinates of element")


class PageIR(BaseModel):
    url: str = Field(description="Current window location URL")
    title: str = Field(description="Current document title")
    elements: List[PageElement] = Field(default_factory=list, description="Flat list of interactive elements")
    text_snippets: List[str] = Field(default_factory=list, description="Top-level static context headings/snippets")
    observed_at: str = Field(description="ISO timestamp of observation")