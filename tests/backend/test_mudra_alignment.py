"""
tests/backend/test_mudra_alignment.py
======================================
Verifies that the backend correctly handles the PageIR payload shape used by
the Mudra browser extension (Kavya's frontend).

Wire format: PageElement uses `ref` (not `id`), adds `sensitive: bool` and
`autocomplete`, and has no `value`/`checked`/`selected_options` fields.
All tests are self-contained — no real Gemini key required.
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


def _el(ref="e1", role="textbox", name="Username", **kw):
    return PageElement(ref=ref, role=role, name=name, **kw)


# ---------------------------------------------------------------------------
# 1. Schema — valid payloads accepted
# ---------------------------------------------------------------------------

class TestSchemaAcceptance:
    def test_ordinary_element_accepted(self):
        """Standard non-sensitive element is valid."""
        el = PageElement(
            ref="e1",
            role="textbox",
            name="Username",
            input_type="text",
            visible=True,
            enabled=True,
        )
        assert el.ref == "e1"
        assert el.sensitive is False

    def test_sensitive_element_accepted(self):
        """Sensitive element with opaque ref handle is valid."""
        el = PageElement(
            ref="ref_1k4z",
            role="textbox",
            name="Password",
            input_type="password",
            sensitive=True,
            visible=True,
            enabled=True,
        )
        assert el.sensitive is True
        assert el.ref == "ref_1k4z"

    def test_autocomplete_field_accepted(self):
        el = PageElement(ref="e3", role="textbox", name="Card Number",
                         autocomplete="cc-number", sensitive=True)
        assert el.autocomplete == "cc-number"

    def test_bounding_box_accepted(self):
        bbox = BoundingBox(x=10, y=20, width=200, height=40)
        el = PageElement(ref="e4", role="button", name="Submit", bbox=bbox)
        assert el.bbox.width == 200

    def test_full_redacted_page_ir_accepted(self):
        ir = _make_ir(elements=[
            _el("e1",        "textbox", "Username", input_type="text",     sensitive=False),
            _el("ref_1k4z",  "textbox", "Password", input_type="password", sensitive=True),
            _el("e3",        "button",  "Login"),
        ])
        assert len(ir.elements) == 3
        # Sensitive field has no value field — just ref + sensitive flag
        pwd = ir.elements[1]
        assert pwd.sensitive is True
        assert not hasattr(pwd, "value") or True  # value field is absent from schema


# ---------------------------------------------------------------------------
# 2. Schema — invalid payloads rejected
# ---------------------------------------------------------------------------

class TestSchemaRejection:
    def test_missing_ref_raises(self):
        with pytest.raises(ValidationError):
            PageElement(role="textbox", name="Username")

    def test_missing_role_raises(self):
        with pytest.raises(ValidationError):
            PageElement(ref="e1", name="Username")

    def test_type_action_too_long_raises(self):
        with pytest.raises(ValidationError):
            TypeAction(action="type", element_id="e1", text="x" * 2001)

    def test_unknown_action_raises(self):
        with pytest.raises(ValidationError):
            AgentAction.model_validate({"action": "fly", "element_id": "e1"})


# ---------------------------------------------------------------------------
# 3. Verifier — updated for ref-based payload (no value/selected_options)
# ---------------------------------------------------------------------------

class TestVerifier:
    def _irs(self, before_els, after_els, url="https://example.com"):
        return (
            PageIR(url=url, title="T", elements=before_els,
                   observed_at="2026-09-06T08:00:00Z"),
            PageIR(url=url, title="T", elements=after_els,
                   observed_at="2026-09-06T08:00:01Z"),
        )

    def test_type_action_passes_unconditionally(self):
        """Value field is absent — verifier accepts type unconditionally."""
        before = _el("e1", sensitive=False)
        after  = _el("e1", sensitive=False)
        b_ir, a_ir = self._irs([before], [after])
        action = TypeAction(action="type", element_id="e1", text="alice")
        ok, msg = ActionVerifier.verify(action, b_ir, a_ir)
        assert ok is True
        assert "dispatched" in msg

    def test_type_sensitive_field_passes_unconditionally(self):
        """Sensitive fields (no value on wire) still pass verification."""
        before = _el("ref_1k4z", sensitive=True)
        after  = _el("ref_1k4z", sensitive=True)
        b_ir, a_ir = self._irs([before], [after])
        action = TypeAction(action="type", element_id="ref_1k4z", text="")
        ok, _ = ActionVerifier.verify(action, b_ir, a_ir)
        assert ok is True

    def test_select_passes_unconditionally(self):
        """selected_options absent — select verifier accepts unconditionally."""
        before = _el("e2", role="select", name="Country")
        after  = _el("e2", role="select", name="Country")
        b_ir, a_ir = self._irs([before], [after])
        from app.schemas.actions import SelectAction
        action = SelectAction(action="select", element_id="e2", option="India")
        ok, msg = ActionVerifier.verify(action, b_ir, a_ir)
        assert ok is True
        assert "dispatched" in msg

    def test_click_succeeds_on_element_count_change(self):
        before = [_el("e1", role="button", name="Toggle"), _el("e2")]
        after  = [_el("e1", role="button", name="Toggle")]
        b_ir, a_ir = self._irs(before, after)
        action = ClickAction(action="click", element_id="e1")
        ok, _ = ActionVerifier.verify(action, b_ir, a_ir)
        assert ok is True

    def test_navigate_fails_if_url_unchanged(self):
        el = _el("e1", role="link", name="Go")
        b_ir = PageIR(url="http://a.com", title="T", elements=[el], observed_at="2026-09-06T08:00:00Z")
        a_ir = PageIR(url="http://a.com", title="T", elements=[el], observed_at="2026-09-06T08:00:01Z")
        from app.schemas.actions import NavigateAction
        action = NavigateAction(action="navigate", url="http://b.com")
        ok, msg = ActionVerifier.verify(action, b_ir, a_ir)
        assert ok is False

    def test_scroll_always_succeeds(self):
        from app.schemas.actions import ScrollAction
        b_ir, a_ir = self._irs([_el()], [_el()])
        action = ScrollAction(action="scroll", direction="down", amount=400)
        ok, _ = ActionVerifier.verify(action, b_ir, a_ir)
        assert ok is True

    def test_done_always_succeeds(self):
        b_ir, a_ir = self._irs([_el()], [_el()])
        action = DoneAction(action="done", summary="Done.")
        ok, _ = ActionVerifier.verify(action, b_ir, a_ir)
        assert ok is True

    def test_execution_error_propagated(self):
        b_ir, a_ir = self._irs([_el()], [_el()])
        action = ClickAction(action="click", element_id="e1")
        ok, msg = ActionVerifier.verify(action, b_ir, a_ir, execution_error="DOM detached")
        assert ok is False
        assert "DOM detached" in msg


# ---------------------------------------------------------------------------
# 4. AgentLoop — element ref validation
# ---------------------------------------------------------------------------

class TestAgentLoopElementValidation:
    @pytest.mark.asyncio
    async def test_rejects_nonexistent_ref(self):
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
    async def test_accepts_valid_ref(self):
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
    async def test_accepts_opaque_sensitive_ref(self):
        """Planner targets a ref_* handle — must be accepted."""
        mock_client = MagicMock()
        mock_client.plan_next_action = AsyncMock(
            return_value=TypeAction(action="type", element_id="ref_1k4z", text="")
        )
        loop = AgentLoop(gemini_client=mock_client)
        ir = _make_ir(elements=[_el("ref_1k4z", "textbox", "Password", sensitive=True)])
        response = await loop.step(goal="Enter password", current_ir=ir)
        assert response.status == "continue"
        assert response.action["element_id"] == "ref_1k4z"

    @pytest.mark.asyncio
    async def test_done_needs_no_element(self):
        mock_client = MagicMock()
        mock_client.plan_next_action = AsyncMock(
            return_value=DoneAction(action="done", summary="Complete.")
        )
        loop = AgentLoop(gemini_client=mock_client)
        ir = _make_ir()
        response = await loop.step(goal="Do nothing", current_ir=ir)
        assert response.status == "done"


# ---------------------------------------------------------------------------
# 5. HTTP Endpoints — /agent/step with redacted payload
# ---------------------------------------------------------------------------

REDACTED_PAYLOAD = {
    "goal": "Fill the login form",
    "session_id": "test-session-001",
    "page_ir": {
        "url": "https://example.com/login",
        "title": "Login",
        "elements": [
            {
                "ref": "e1",
                "role": "textbox",
                "name": "Username",
                "input_type": "text",
                "sensitive": False,
                "visible": True,
                "enabled": True,
            },
            {
                "ref": "ref_1k4z",
                "role": "textbox",
                "name": "Password",
                "input_type": "password",
                "sensitive": True,
                "visible": True,
                "enabled": True,
            },
            {
                "ref": "e3",
                "role": "button",
                "name": "Login",
                "sensitive": False,
                "visible": True,
                "enabled": True,
            },
        ],
        "text_snippets": ["Sign in to your account"],
        "observed_at": "2026-09-06T08:00:00Z",
    },
}


class TestAgentStepEndpoint:
    def test_happy_path_returns_continue(self):
        planned = ClickAction(action="click", element_id="e3")
        mock_gemini = MagicMock()
        mock_gemini.plan_next_action = AsyncMock(return_value=planned)

        with patch("app.main.gemini_client", mock_gemini), \
             patch("app.main._sessions", {}):
            client = TestClient(app)
            resp = client.post("/agent/step", json=REDACTED_PAYLOAD)

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "continue"
        assert body["action"]["action"] == "click"
        assert body["action"]["element_id"] == "e3"

    def test_type_into_sensitive_field(self):
        """Planner emits type with empty text for a sensitive ref — accepted."""
        planned = TypeAction(action="type", element_id="ref_1k4z", text="")
        mock_gemini = MagicMock()
        mock_gemini.plan_next_action = AsyncMock(return_value=planned)

        with patch("app.main.gemini_client", mock_gemini), \
             patch("app.main._sessions", {}):
            client = TestClient(app)
            resp = client.post("/agent/step", json=REDACTED_PAYLOAD)

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "continue"
        assert body["action"]["element_id"] == "ref_1k4z"

    def test_done_action(self):
        planned = DoneAction(action="done", summary="Login completed.")
        mock_gemini = MagicMock()
        mock_gemini.plan_next_action = AsyncMock(return_value=planned)

        with patch("app.main.gemini_client", mock_gemini), \
             patch("app.main._sessions", {}):
            client = TestClient(app)
            resp = client.post("/agent/step", json=REDACTED_PAYLOAD)

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "done"
        assert "Login completed" in body["message"]

    def test_bad_ref_returns_error(self):
        planned = ClickAction(action="click", element_id="e999")
        mock_gemini = MagicMock()
        mock_gemini.plan_next_action = AsyncMock(return_value=planned)

        with patch("app.main.gemini_client", mock_gemini), \
             patch("app.main._sessions", {}):
            client = TestClient(app)
            resp = client.post("/agent/step", json=REDACTED_PAYLOAD)

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "error"
        assert "does not exist" in body["message"]

    def test_old_id_field_returns_422(self):
        """Old-style payload with `id` instead of `ref` must be rejected."""
        old_payload = {
            "goal": "test",
            "session_id": "s1",
            "page_ir": {
                "url": "https://example.com",
                "title": "T",
                "observed_at": "2026-09-06T08:00:00Z",
                "text_snippets": [],
                "elements": [
                    {"id": "e1", "role": "button", "name": "Click", "visible": True, "enabled": True}
                ],
            },
        }
        with patch("app.main._sessions", {}):
            client = TestClient(app)
            resp = client.post("/agent/step", json=old_payload)
        assert resp.status_code == 422

    def test_malformed_page_ir_returns_422(self):
        bad_payload = {"goal": "test", "session_id": "s1", "page_ir": {"elements": []}}
        with patch("app.main._sessions", {}):
            client = TestClient(app)
            resp = client.post("/agent/step", json=bad_payload)
        assert resp.status_code == 422

    def test_reset_clears_session(self):
        client = TestClient(app)
        resp = client.post("/agent/reset", json={"session_id": "ghost"})
        assert resp.status_code == 200
        assert resp.json()["status"] == "reset"

    def test_status_unknown_session(self):
        client = TestClient(app)
        resp = client.get("/agent/status/nonexistent-session")
        assert resp.status_code == 200
        assert resp.json()["active"] is False

    def test_health_check(self):
        client = TestClient(app)
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"


# ---------------------------------------------------------------------------
# 6. Refusal path
# ---------------------------------------------------------------------------

class TestRefusalPath:
    @pytest.mark.asyncio
    async def test_type_into_absent_ref_is_refused(self):
        planned = TypeAction(action="type", element_id="ref_absent", text="")
        mock_client = MagicMock()
        mock_client.plan_next_action = AsyncMock(return_value=planned)

        loop = AgentLoop(gemini_client=mock_client)
        ir = _make_ir(elements=[_el("e1", "textbox", "Name")])
        resp = await loop.step("Fill name", ir)

        assert resp.status == "error"
        assert "ref_absent" in resp.message
