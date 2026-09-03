from typing import Literal, Union, Any
from pydantic import BaseModel, Field, RootModel


class ClickAction(BaseModel):
    action: Literal["click"]
    element_id: str = Field(description="Target element ID from current Page IR (e.g., 'e1')")


class TypeAction(BaseModel):
    action: Literal["type"]
    element_id: str = Field(description="Target input/textarea element ID")
    text: str = Field(max_length=2000, description="Text string to insert into the element")


class SelectAction(BaseModel):
    action: Literal["select"]
    element_id: str = Field(description="Target dropdown element ID")
    option: str = Field(description="Option value or label to select")


class ScrollAction(BaseModel):
    action: Literal["scroll"]
    direction: Literal["up", "down"]
    amount: int = Field(default=400, ge=0, le=5000, description="Pixel amount to scroll")


class NavigateAction(BaseModel):
    action: Literal["navigate"]
    url: str = Field(description="Target URL to navigate the active tab to")


class WaitAction(BaseModel):
    action: Literal["wait"]
    duration_ms: int = Field(default=1000, ge=0, le=10000, description="Duration to wait in milliseconds")


class ExtractAction(BaseModel):
    action: Literal["extract"]
    element_id: str = Field(description="Target element ID to extract textual data from")


class DoneAction(BaseModel):
    action: Literal["done"]
    summary: str = Field(description="Final summary explanation of completed task")


# Discriminated union of all supported actions wrapped in a RootModel
class AgentAction(RootModel):
    root: Union[
        ClickAction,
        TypeAction,
        SelectAction,
        ScrollAction,
        NavigateAction,
        WaitAction,
        ExtractAction,
        DoneAction,
    ] = Field(..., discriminator="action")

    @classmethod
    def model_validate(cls, obj: Any, *args, **kwargs) -> Any:
        parsed = super().model_validate(obj, *args, **kwargs)
        return parsed.root