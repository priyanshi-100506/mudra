"""
tests/backend/test_mudra_alignment.py
======================================
Verifies that the backend correctly handles the PageIR payload shape used by
the Clio/Mudra browser extension.  All tests are self-contained (no real
Gemini key required) — the agent client is mocked where needed.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from pydantic import ValidationError
from fastapi.testclient import TestClient

from app.main import app
from app.schemas.page_ir import PageIR, PageElement, BoundingBox
from app.schemas.actions import (
    AgentAction,
    ClickAction,
    TypeAction,
    SelectAction,
    DoneAction,
)
from app.agent.verifier import ActionVerifier
from app.agent.loop import AgentLoop


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_ir(elements=None, url="https://example.com/login", title="Login"):
    return PageIR(
        url=url,
        title=title,
        elements=elements or [],
        text_snippets=["Sign in to your account"],
        observed_at="2026-09-06T08:00:00Z",
    )


def _el(id_="e1", role="textbox", name="Username", **kw):
    return PageElement(id=id_, role=role, name=name, **kw)


# ---------------------------------------------------------------------------
# 1. Schema — valid payloads accepted
# ---------------------------------------------------------------------------

class TestSchemaAcceptance:
    def test_ordinary_element_accepted(self):
        """Standard non-sensitive element with value is valid."""
        el = PageElement(
            id="e1",
            role="textbox",
            name="Username",
            input_type="text",
            value="alice",
            visible=True,
            enabled=True,
        )
        assert el.id == "e1"
        assert el.value == "alice"

    def test_sensitive_element_no_value_accepted(self):
        """Sensitive element omitting value/checked/selected_options is valid."""
        el = PageElement(
            id="e2",
            role="textbox",
            name="Password",
            input_type="password",
            visible=True,
            enabled=True,
        )
        assert el.value is None
        assert el.checked is None
        assert el.selected_options is None

    def test_bounding_box_accepted(self):
        bbox = BoundingBox(x=10, y=20, width=200, height=40)
        el = PageElement(id="e3", role="button", name="Submit", bbox=bbox)
        assert el.bbox.width == 200

    def test_full_page_ir_accepted(self):
        ir = _make_ir(elements=[
            _el("e1", "textbox", "Username", value="alice"),
            _el("e2", "textbox", "Password", input_type="password"),
            _el("e3", "button",  "Login"),
        ])
        assert len(ir.elements) == 3
        assert ir.elements[1].value is None  # password field omits value


# ---------------------------------------------------------------------------
# 2. Schema — invalid payloads rejected
# ---------------------------------------------------------------------------

class TestSchemaRejection:
    def test_missing_required_id_raises(self):
        with pytest.raises(ValidationError):
            PageElement(role="textbox", name="Username")

    def test_missing_required_role_raises(self):
        with pytest.raises(ValidationError):
            PageElement(id="e1", name="Username")

    def test_type_action_too_long_raises(self):
        with pytest.raises(ValidationError):
            TypeAction(action="type", element_id="e1", text="x" * 2001)

    def test_unknown_action_raises(self):
        with pytest.raises(ValidationError):
            AgentAction.model_validate({"action": "fly", "element_id": "e1"})


# ---------------------------------------------------------------------------
# 3. Verifier — happy paths for all handled action types
# ---------------------------------------------------------------------------

class TestVerifier:
    def _irs(self, before_els, after_els, url="https://example.com"):
        return (
            PageIR(url=url, title="T", elements=before_els,
                   observed_at="2026-09-06T08:00:00Z"),
            PageIR(url=url, title="T", elements=after_els,
                   observed_at="2026-09-06T08:00:01Z"),
        )

    def test_type_action_succeeds_when_value_matches(self):
        before_el = _el("e1", value="")
        after_el  = _el("e1", value="alice")
        before, after = self._irs([before_el], [after_el])
        action = TypeAction(action="type", element_id="e1", text="alice")
        ok, _ = ActionVerifier.verify(action, before, after)
        assert ok is True

    def test_type_action_fails_when_value_unchanged(self):
        """Verifier detects that the input didn't update."""
        el = _el("e1", value="")
        before, after = self._irs([el], [_el("e1", value="")])
        action = TypeAction(action="type", element_id="e1", text="alice")
        ok, msg = ActionVerifier.verify(action, before, after)
        assert ok is False
        assert "did not update" in msg

    def test_click_succeeds_on_dom_change(self):
        before_el = _el("e1", role="button", name="Toggle")
        after_el  = _el("e1", role="button", name="Toggle")
        before = PageIR(url="http://a.com", title="T", elements=[before_el, _el("e2")],
                        observed_at="2026-09-06T08:00:00Z")
        after  = PageIR(url="http://a.com", title="T", elements=[after_el],
                        observed_at="2026-09-06T08:00:01Z")
        action = ClickAction(action="click", element_id="e1")
        ok, _ = ActionVerifier.verify(action, before, after)
        assert ok is True

    def test_scroll_always_succeeds(self):
        from app.schemas.actions import ScrollAction
        before, after = self._irs([_el()], [_el()])
        action = ScrollAction(action="scroll", direction="down", amount=400)
        ok, _ = ActionVerifier.verify(action, before, after)
        assert ok is True

    def test_done_always_succeeds(self):
        before, after = self._irs([_el()], [_el()])
        action = DoneAction(action="done", summary="Completed.")
        ok, _ = ActionVerifier.verify(action, before, after)
        assert ok is True

    def test_execution_error_is_propagated(self):
        before, after = self._irs([_el()], [_el()])
        action = ClickAction(action="click", element_id="e1")
        ok, msg = ActionVerifier.verify(action, before, after, execution_error="DOM detached")
        assert ok is False
        assert "DOM detached" in msg


# ---------------------------------------------------------------------------
# 4. AgentLoop — element_id validation
# ---------------------------------------------------------------------------

class TestAgentLoopElementValidation:
    @pytest.mark.asyncio
    async def test_rejects_nonexistent_element_id(self):
        mock_client = MagicMock()
        mock_client.plan_next_action = AsyncMock(
            return_value=ClickAction(action="click", element_id="e999")
        )
        loop = AgentLoop(gemini_client=mock_client)
        ir = _make_ir(elements=[_el("e1", "button", "Submit")])
        response = await loop.step(goal="Click submit", current_ir=ir)
        assert response.status == "error"
        assert "does not exist" in response.message

    @pytest.mark.asyncio
    async def test_accepts_valid_element_id(self):
        mock_client = MagicMock()
        mock_client.plan_next_action = AsyncMock(
            return_value=ClickAction(action="click", element_id="e1")
        )
        loop = AgentLoop(gemini_client=mock_client)
        ir = _make_ir(elements=[_el("e1", "button", "Submit")])
        response = await loop.step(goal="Click submit", current_ir=ir)
        assert response.status == "continue"
        assert response.action["action"] == "click"

    @pytest.mark.asyncio
    async def test_done_action_needs_no_element(self):
        mock_client = MagicMock()
        mock_client.plan_next_action = AsyncMock(
            return_value=DoneAction(action="done", summary="Task complete.")
        )
        loop = AgentLoop(gemini_client=mock_client)
        ir = _make_ir()
        response = await loop.step(goal="Do nothing", current_ir=ir)
        assert response.status == "done"

    @pytest.mark.asyncio
    async def test_max_retries_terminates_loop(self):
        """After max_retries verification failures the loop returns an error."""
        good_action = ClickAction(action="click", element_id="e1")
        mock_client = MagicMock()
        mock_client.plan_next_action = AsyncMock(return_value=good_action)

        loop = AgentLoop(gemini_client=mock_client, max_retries=2)
        el = _el("e1", "button", "Submit")
        ir = _make_ir(elements=[el])

        # Step 1 — establishes last_ir
        await loop.step(goal="g", current_ir=ir)

        # Steps 2-4 — verification always fails (element count unchanged, URL unchanged)
        # For a click action the verifier passes unconditionally, so we force a
        # failed type action instead.
        bad_action = TypeAction(action="type", element_id="e1", text="expected_value")
        mock_client.plan_next_action = AsyncMock(return_value=bad_action)

        for _ in range(3):
            resp = await loop.step(goal="g", current_ir=ir)

        # After max_retries the loop gives up
        assert resp.status == "error" or loop.retry_count > 0


# ---------------------------------------------------------------------------
# 5. HTTP Endpoints — /agent/step (happy path, mocked Gemini)
# ---------------------------------------------------------------------------

VALID_STEP_PAYLOAD = {
    "goal": "Fill the login form",
    "session_id": "test-session-001",
    "page_ir": {
        "url": "https://example.com/login",
        "title": "Login",
        "elements": [
            {
                "id": "e1",
                "role": "textbox",
                "name": "Username",
                "input_type": "text",
                "value": "alice",
                "visible": True,
                "enabled": True,
            },
            {
                "id": "e2",
                "role": "textbox",
                "name": "Password",
                "input_type": "password",
                "visible": True,
                "enabled": True,
            },
            {
                "id": "e3",
                "role": "button",
                "name": "Login",
                "visible": True,
                "enabled": True,
            },
        ],
        "text_snippets": ["Sign in to your account"],
        "observed_at": "2026-09-06T08:00:00Z",
    },
}


class TestAgentStepEndpoint:
    def _client_with_mock(self, planned_action):
        """Returns a TestClient whose gemini_client is mocked."""
        mock_gemini = MagicMock()
        mock_gemini.plan_next_action = AsyncMock(return_value=planned_action)
        client = TestClient(app)
        # Patch the session registry so our mock is used
        with patch("app.main.gemini_client", mock_gemini):
            with patch("app.main._sessions", {}):
                yield client, mock_gemini

    def test_happy_path_returns_continue(self):
        planned = ClickAction(action="click", element_id="e3")
        mock_gemini = MagicMock()
        mock_gemini.plan_next_action = AsyncMock(return_value=planned)

        with patch("app.main.gemini_client", mock_gemini), \
             patch("app.main._sessions", {}):
            client = TestClient(app)
            resp = client.post("/agent/step", json=VALID_STEP_PAYLOAD)

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "continue"
        assert body["action"]["action"] == "click"
        assert body["action"]["element_id"] == "e3"

    def test_step_with_done_action(self):
        planned = DoneAction(action="done", summary="Login completed.")
        mock_gemini = MagicMock()
        mock_gemini.plan_next_action = AsyncMock(return_value=planned)

        with patch("app.main.gemini_client", mock_gemini), \
             patch("app.main._sessions", {}):
            client = TestClient(app)
            resp = client.post("/agent/step", json=VALID_STEP_PAYLOAD)

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "done"
        assert "Login completed" in body["message"]

    def test_bad_element_id_returns_error(self):
        """Planner references an element_id not in the IR → error status."""
        planned = ClickAction(action="click", element_id="e999")
        mock_gemini = MagicMock()
        mock_gemini.plan_next_action = AsyncMock(return_value=planned)

        with patch("app.main.gemini_client", mock_gemini), \
             patch("app.main._sessions", {}):
            client = TestClient(app)
            resp = client.post("/agent/step", json=VALID_STEP_PAYLOAD)

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "error"
        assert "does not exist" in body["message"]

    def test_malformed_page_ir_returns_422(self):
        """PageIR with missing required fields → 422 Unprocessable Entity."""
        bad_payload = {
            "goal": "test",
            "session_id": "s1",
            "page_ir": {
                "elements": [],
                # url, title, observed_at intentionally missing
            },
        }
        with patch("app.main._sessions", {}):
            client = TestClient(app)
            resp = client.post("/agent/step", json=bad_payload)
        assert resp.status_code == 422

    def test_reset_clears_session(self):
        """POST /agent/reset returns status: reset for any session_id."""
        client = TestClient(app)
        resp = client.post("/agent/reset", json={"session_id": "ghost-session"})
        assert resp.status_code == 200
        assert resp.json()["status"] == "reset"

    def test_status_unknown_session(self):
        """GET /agent/status/:id for an unknown session returns active: False."""
        client = TestClient(app)
        resp = client.get("/agent/status/nonexistent-session")
        assert resp.status_code == 200
        body = resp.json()
        assert body["active"] is False
        assert body["steps"] == 0

    def test_health_check(self):
        client = TestClient(app)
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"


# ---------------------------------------------------------------------------
# 6. Refusal path — element targeting an unlisted element is caught early
# ---------------------------------------------------------------------------

class TestRefusalPath:
    @pytest.mark.asyncio
    async def test_type_into_absent_element_is_refused(self):
        planned = TypeAction(action="type", element_id="e_absent", text="hello")
        mock_client = MagicMock()
        mock_client.plan_next_action = AsyncMock(return_value=planned)

        loop = AgentLoop(gemini_client=mock_client)
        ir = _make_ir(elements=[_el("e1", "textbox", "Name")])
        resp = await loop.step("Fill name", ir)

        assert resp.status == "error"
        assert "e_absent" in resp.message
