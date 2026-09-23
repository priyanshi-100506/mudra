"""Chooses which brain answers, and says so out loud.

Three planners, one interface. The choice is configuration, not a code path
somebody has to remember to change:

  gemini — hosted, needs a key and a network
  ollama — a local VLM on this machine, accepts the redacted screenshot
  stub   — deterministic, no key and no network

The part that matters operationally is `describe()`. "The plans got worse"
and "the backend silently changed" must never look alike: the first is a
model problem and the second is a configuration problem, and mistaking one
for the other burns the time you do not have. So the active planner is
reported by /health and shown in the panel, and a stub that is running says
it is running.
"""

import os
from typing import Any, Dict, Optional

from app.config import settings
from app.schemas.page_ir import PageIR
from app.agent import stub_planner


class StubPlannerClient:
    """Wraps the deterministic planner in the async client interface."""

    name = "stub"

    def __init__(self, obey_injection: Optional[bool] = None):
        # STUB_OBEY_INJECTION=1 makes the stub behave like a planner that
        # fell for the hidden instruction on the page. The demo needs the
        # attack to happen on cue; the refusal that follows is real.
        self.obey_injection = (
            obey_injection
            if obey_injection is not None
            else os.getenv("STUB_OBEY_INJECTION", "").strip() in ("1", "true", "yes")
        )

    async def plan_next_action(
        self,
        goal: str,
        page_ir: PageIR,
        history: Optional[list] = None,
        last_result: Optional[str] = None,
        **_: Any,
    ) -> Dict[str, Any]:
        return stub_planner.plan(goal, page_ir, history, obey_injection=self.obey_injection)

    async def health(self) -> Dict[str, Any]:
        return {
            "reachable": True,
            "model_present": True,
            "detail": "obeying the page's injected instruction (demo)" if self.obey_injection else None,
        }


class UnknownPlanner(ValueError):
    pass


def build_planner(name: Optional[str] = None):
    """Returns the configured planner client.

    An unrecognised name raises rather than falling back. A silent fallback
    to the stub is the specific outcome this module exists to prevent: it
    would serve canned plans that look like a working agent, from a backend
    nobody realised was misconfigured.
    """
    choice = (name or settings.PLANNER).strip().lower()

    if choice == "stub":
        return StubPlannerClient()

    if choice == "ollama":
        from app.agent.ollama_client import OllamaAgentClient
        return OllamaAgentClient()

    if choice == "gemini":
        from app.agent.gemini_client import GeminiAgentClient
        client = GeminiAgentClient()
        setattr(client, "name", "gemini")
        return client

    raise UnknownPlanner(
        f"PLANNER={choice!r} is not one of {settings.valid_planners()}. "
        "Refusing to guess: a wrong guess here means serving plans from a "
        "backend nobody chose."
    )


async def describe(planner: Any) -> Dict[str, Any]:
    """What /health and the panel report about the live planner."""
    name = getattr(planner, "name", "unknown")
    info: Dict[str, Any] = {
        "planner": name,
        "offline": name in ("ollama", "stub"),
        "model": getattr(planner, "model", None),
    }
    health = getattr(planner, "health", None)
    if callable(health):
        try:
            info.update(await health())
        except Exception as exc:  # health must never take the endpoint down
            info.update({"reachable": False, "model_present": False, "detail": str(exc)})
    else:
        # Gemini: a key present is the most we can say without spending a call.
        info.update({
            "reachable": bool(settings.GEMINI_API_KEY),
            "model_present": bool(settings.GEMINI_API_KEY),
            "detail": None if settings.GEMINI_API_KEY else "GEMINI_API_KEY is not set.",
        })
    return info
