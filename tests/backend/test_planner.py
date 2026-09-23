"""The planner switch, the stub's competence, and the Ollama failure modes."""

import json

import pytest
from fastapi.testclient import TestClient

from app.agent.planner import build_planner, describe, StubPlannerClient, UnknownPlanner
from app.agent import stub_planner
from app.agent.ollama_client import OllamaAgentClient, OllamaUnavailable, _first_json_object
from app.config import settings
from app.schemas.actions import AgentAction
from app.schemas.page_ir import PageIR, PageElement


def ir(elements, url="https://fixture.test/form", title="Form") -> PageIR:
    return PageIR(url=url, title=title, elements=elements,
                  text_snippets=[], observed_at="2026-01-01T00:00:00Z")


def textbox(eid, name, value="", input_type="text"):
    return PageElement(id=eid, role="textbox", name=name, value=value,
                       input_type=input_type, visible=True, enabled=True)


class TestPlannerSelection:
    def test_builds_each_named_planner(self):
        assert build_planner("stub").name == "stub"
        assert build_planner("ollama").name == "ollama"

    def test_refuses_an_unknown_name_instead_of_falling_back(self):
        # A silent fallback to the stub would serve canned plans that look
        # like a working agent, from a backend nobody chose.
        with pytest.raises(UnknownPlanner) as e:
            build_planner("gpt5")
        assert "Refusing to guess" in str(e.value)

    def test_the_default_is_not_the_stub(self):
        # A stub running by default is invisible until a judge asks for
        # something the canned plan does not cover.
        assert settings.PLANNER != "stub"
        assert settings.PLANNER in settings.valid_planners()

    def test_is_case_and_whitespace_tolerant(self):
        assert build_planner("  STUB ").name == "stub"


class TestDescribe:
    @pytest.mark.asyncio
    async def test_names_the_stub_as_the_stub(self):
        info = await describe(StubPlannerClient())
        assert info["planner"] == "stub"
        assert info["offline"] is True
        assert info["reachable"] is True

    @pytest.mark.asyncio
    async def test_reports_ollama_as_offline_and_names_the_model(self):
        info = await describe(OllamaAgentClient(url="http://127.0.0.1:1", model="qwen2.5vl:3b"))
        assert info["planner"] == "ollama"
        assert info["offline"] is True
        assert info["model"] == "qwen2.5vl:3b"
        # Nothing is listening on port 1; that must read as unreachable
        # rather than take the health endpoint down.
        assert info["reachable"] is False


class TestStubIsDemoCapable:
    """The stub is the fallback if Ollama misbehaves on stage, so it has to
    carry a complete task rather than prove the wiring works."""

    def test_fills_the_first_empty_field(self):
        page = ir([textbox("e1", "Full name"), textbox("e2", "Email")])
        action = stub_planner.plan("fill the form", page, [])
        assert action["action"] == "type"
        assert action["element_id"] == "e1"
        assert action["text"] == "Asha Verma"

    def test_chooses_a_plausible_value_per_field(self):
        page = ir([textbox("e1", "Email address")])
        assert "@example.test" in stub_planner.plan("x", page, [])["text"]

    def test_moves_on_rather_than_retyping(self):
        page = ir([textbox("e1", "Full name"), textbox("e2", "Email")])
        history = [{"action": {"action": "type", "element_id": "e1", "text": "Asha Verma"}}]
        assert stub_planner.plan("x", page, history)["element_id"] == "e2"

    def test_skips_a_field_that_already_has_content(self):
        page = ir([textbox("e1", "Full name", value="Already here"), textbox("e2", "Email")])
        assert stub_planner.plan("x", page, [])["element_id"] == "e2"

    def test_leaves_sealed_fields_alone(self):
        # A sealed field's value never arrives, so there is nothing to type
        # and no business trying. It is also the honest demo: the agent works
        # around protected fields rather than through them.
        page = ir([
            PageElement(id="ref_ab12", role="textbox", name="Password",
                        input_type="password", value=None, visible=True, enabled=True),
            textbox("e2", "Email"),
        ])
        assert stub_planner.plan("x", page, [])["element_id"] == "e2"

    def test_submits_once_there_is_nothing_left_to_fill(self):
        page = ir([
            textbox("e1", "Full name", value="Asha Verma"),
            PageElement(id="e9", role="button", name="Submit", visible=True, enabled=True),
        ])
        action = stub_planner.plan("x", page, [])
        assert action == {"action": "submit", "element_id": "e9"}

    def test_finishes_after_submitting(self):
        page = ir([PageElement(id="e9", role="button", name="Submit", visible=True, enabled=True)])
        history = [{"action": {"action": "submit", "element_id": "e9"}}]
        action = stub_planner.plan("pay the bill", page, history)
        assert action["action"] == "done"
        assert "pay the bill" in action["summary"]

    def test_says_so_rather_than_flailing_on_an_unfamiliar_page(self):
        # A scripted stub walks off the end of its list in front of people.
        action = stub_planner.plan("x", ir([]), [])
        assert action["action"] == "done"
        assert "Nothing left to do" in action["summary"]

    def test_ignores_hidden_and_disabled_elements(self):
        page = ir([
            PageElement(id="e1", role="textbox", name="Hidden", visible=False, enabled=True, value=""),
            PageElement(id="e2", role="textbox", name="Disabled", visible=True, enabled=False, value=""),
            textbox("e3", "Email"),
        ])
        assert stub_planner.plan("x", page, [])["element_id"] == "e3"

    def test_every_action_validates_against_the_real_schema(self):
        # The stub is stubbed in its choosing, not in its output. Anything it
        # emits goes through the same grant, confirmation and executor path.
        page = ir([textbox("e1", "Full name"),
                   PageElement(id="e9", role="button", name="Pay", visible=True, enabled=True)])
        history = []
        for _ in range(6):
            action = stub_planner.plan("pay the bill", page, history)
            AgentAction.model_validate(action)
            history.append({"action": action})
            if action["action"] == "done":
                break
        assert history[-1]["action"]["action"] == "done"

    def test_drives_a_multi_step_task_to_completion(self):
        page = ir([
            textbox("e1", "Full name"),
            textbox("e2", "Email"),
            textbox("e3", "Mobile"),
            PageElement(id="e9", role="button", name="Submit", visible=True, enabled=True),
        ])
        history, kinds = [], []
        for _ in range(10):
            action = stub_planner.plan("apply for the scheme", page, history)
            kinds.append(action["action"])
            history.append({"action": action})
            if action["action"] == "done":
                break
        assert kinds == ["type", "type", "type", "submit", "done"]


class TestOllamaFailureModes:
    @pytest.mark.asyncio
    async def test_403_names_the_cause_and_the_fix(self):
        # Ollama's CORS allowlist has no extension origin by default, and the
        # failure is quiet: the server is up, the model is loaded, and local
        # inference simply never runs.
        import httpx

        class Refusing(httpx.AsyncClient):
            async def post(self, *_a, **_k):
                return httpx.Response(403, text="forbidden",
                                      request=httpx.Request("POST", "http://x"))

        client = OllamaAgentClient(url="http://127.0.0.1:11434")
        import app.agent.ollama_client as mod
        original = mod.httpx.AsyncClient
        mod.httpx.AsyncClient = Refusing
        try:
            with pytest.raises(OllamaUnavailable) as e:
                await client.plan_next_action("x", ir([]))
        finally:
            mod.httpx.AsyncClient = original
        assert "OLLAMA_ORIGINS" in str(e.value)

    @pytest.mark.asyncio
    async def test_unreachable_names_the_start_command(self):
        client = OllamaAgentClient(url="http://127.0.0.1:1")
        with pytest.raises(OllamaUnavailable) as e:
            await client.plan_next_action("x", ir([]))
        assert "OLLAMA_ORIGINS" in str(e.value)

    @pytest.mark.asyncio
    async def test_health_distinguishes_a_missing_model_from_a_dead_server(self):
        # "Running but never pulled" reads as the agent getting worse unless
        # it is reported as what it is.
        info = await OllamaAgentClient(url="http://127.0.0.1:1").health()
        assert info["reachable"] is False

    def test_recovers_json_from_a_chatty_reply(self):
        # Small local models add a preamble more often than hosted ones, even
        # when told not to. Failing the step over it would make the offline
        # path look far worse than it is.
        got = _first_json_object('Sure! Here you go:\n```json\n{"action":"click","element_id":"e1"}\n```')
        assert got == {"action": "click", "element_id": "e1"}

    def test_raises_rather_than_inventing_an_action_when_there_is_no_json(self):
        with pytest.raises(OllamaUnavailable):
            _first_json_object("I am not able to help with that.")


class TestHealthEndpoint:
    """Patches the live planner rather than reloading the module.

    An earlier version of this reloaded app.main to swap the planner, which
    left the module permanently rebuilt and quietly turned two unrelated
    tests into stub tests. Reloading a module under test contaminates every
    test that imported it afterwards, and the symptom appears somewhere else
    entirely.
    """

    def test_names_the_backend_that_is_answering(self, monkeypatch):
        import app.main as main_mod

        monkeypatch.setattr(main_mod, "planner_client", StubPlannerClient())
        with TestClient(main_mod.app) as client:
            body = client.get("/health").json()
        assert body["planner"] == "stub"
        assert body["offline"] is True
        assert body["status"] == "ok"

    def test_says_so_when_no_planner_could_be_built(self, monkeypatch):
        import app.main as main_mod

        monkeypatch.setattr(main_mod, "planner_client", None)
        monkeypatch.setattr(main_mod, "planner_error", "PLANNER='gpt5' is not valid")
        with TestClient(main_mod.app) as client:
            body = client.get("/health").json()
        assert body["status"] == "error"
        assert "gpt5" in body["detail"]

    def test_reports_degraded_rather_than_ok_when_the_model_is_absent(self, monkeypatch):
        import app.main as main_mod

        monkeypatch.setattr(
            main_mod, "planner_client",
            OllamaAgentClient(url="http://127.0.0.1:1", model="qwen2.5vl:3b"),
        )
        with TestClient(main_mod.app) as client:
            body = client.get("/health").json()
        # Unreachable must not read as healthy; that is the whole point of
        # naming the backend at all.
        assert body["status"] == "degraded"
        assert body["planner"] == "ollama"
