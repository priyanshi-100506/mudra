import pytest
from pydantic import ValidationError
from app.schemas.actions import ClickAction, TypeAction, AgentAction
from app.schemas.page_ir import PageIR, PageElement
from app.agent.verifier import ActionVerifier
from app.agent.loop import AgentLoop
from unittest.mock import AsyncMock, MagicMock


def test_valid_click_action():
    action = AgentAction.model_validate({"action": "click", "element_id": "e1"})
    assert isinstance(action, ClickAction)
    assert action.element_id == "e1"


def test_invalid_action_type_raises():
    with pytest.raises(ValidationError):
        AgentAction.model_validate({"action": "invalid_action", "element_id": "e1"})


def test_type_action_max_length_constraint():
    long_text = "a" * 2001
    with pytest.raises(ValidationError):
        TypeAction(action="type", element_id="e2", text=long_text)


def test_verifier_type_action_success():
    before_el = PageElement(id="e1", role="textbox", name="Email", value="")
    after_el = PageElement(id="e1", role="textbox", name="Email", value="user@example.com")

    before_ir = PageIR(url="http://test.com", title="Test", elements=[before_el], observed_at="2026-01-01T00:00:00Z")
    after_ir = PageIR(url="http://test.com", title="Test", elements=[after_el], observed_at="2026-01-01T00:00:01Z")

    action = TypeAction(action="type", element_id="e1", text="user@example.com")
    success, msg = ActionVerifier.verify(action, before_ir, after_ir)

    assert success is True
    assert "updated" in msg


@pytest.mark.asyncio
async def test_agent_loop_rejects_nonexistent_element_id():
    mock_client = MagicMock()
    mock_client.plan_next_action = AsyncMock(
        return_value=ClickAction(action="click", element_id="e999")
    )

    loop = AgentLoop(gemini_client=mock_client)
    current_ir = PageIR(
        url="http://test.com",
        title="Test",
        elements=[PageElement(id="e1", role="button", name="Submit")],
        observed_at="2026-01-01T00:00:00Z"
    )

    response = await loop.step(goal="Click button", current_ir=current_ir)
    assert response.status == "error"
    assert "does not exist" in response.message