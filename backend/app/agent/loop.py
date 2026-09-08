import asyncio
from typing import Any, Dict, List, Optional
from pydantic import BaseModel
from app.agent.gemini_client import GeminiAgentClient
from app.agent.verifier import ActionVerifier
from app.schemas.actions import AgentAction, DoneAction
from app.schemas.page_ir import PageIR
from app.manifest_store import manifest_store
from app.schemas.manifest import EgressManifestEntry


class LoopStepResponse(BaseModel):
    action: Any  # serialised action dict
    status: str  # "continue" | "done" | "error"
    message: str
    extracted_data: Optional[str] = None


class AgentLoop:
    def __init__(self, gemini_client: GeminiAgentClient, max_retries: int = 3):
        self.gemini_client = gemini_client
        self.max_retries = max_retries
        self.history: List[Dict[str, Any]] = []
        self.retry_count = 0
        self.last_result: Optional[str] = None
        self.last_ir: Optional[PageIR] = None

    def reset(self):
        """Clear all session state so the loop can be reused for a new task."""
        self.history.clear()
        self.retry_count = 0
        self.last_result = None
        self.last_ir = None

    async def step(self, goal: str, current_ir: PageIR) -> LoopStepResponse:
        # Verify previous action if we have prior state
        if self.last_ir and self.history:
            last_action_dict = self.history[-1]["action"]
            last_action = AgentAction.model_validate(last_action_dict)
            success, message = ActionVerifier.verify(last_action, self.last_ir, current_ir)

            if not success:
                self.retry_count += 1
                self.last_result = f"failed: {message}"
                if self.retry_count > self.max_retries:
                    return LoopStepResponse(
                        action={"action": "done", "summary": "Max retries exceeded"},
                        status="error",
                        message=f"Task failed after {self.max_retries} repeated verification failures: {message}",
                    )
            else:
                self.retry_count = 0
                self.last_result = "success"

        # Plan next action via Gemini
        action = await self.gemini_client.plan_next_action(
            goal=goal,
            page_ir=current_ir,
            history=self.history,
            last_result=self.last_result,
        )

        # Validate element_id exists in current IR (for element-targeting actions).
        if hasattr(action, "element_id"):
            valid_ids = {e.id for e in current_ir.elements}
            if action.element_id not in valid_ids:
                self.last_result = f"Error: element_id '{action.element_id}' does not exist in current Page IR."
                return LoopStepResponse(
                    action=action.model_dump(),
                    status="error",
                    message=self.last_result,
                )

        # Handle wait action: sleep on backend before responding so extension
        # doesn't immediately re-observe a page that is still loading
        # Record step
        action_dict = action.model_dump()
        self.history.append({"action": action_dict, "result": self.last_result or "pending"})
        self.last_ir = current_ir

        # Auto-record egress manifest entry
        redacted_count = sum(
            1 for element in current_ir.elements
            if element.id.startswith("ref_")
        )
        manifest_store.record(
            EgressManifestEntry(
                session_id="default",
                target_url=current_ir.url,
                action_type=action.action,
                status="allowed",
                redacted_refs_count=redacted_count,
                details={"action": action_dict}
            )
        )

        if action.action == "done":
            return LoopStepResponse(
                action=action_dict,
                status="done",
                message=action.summary,
            )

        label = _action_label(action)
        return LoopStepResponse(
            action=action_dict,
            status="continue",
            message=f"Action planned: {label}",
        )


def _action_label(action: Any) -> str:
    """Human-readable one-liner for an action, shown in the status log."""
    a = action.action
    if a == "click":
        return f"click({action.element_id})"
    if a == "type":
        preview = action.text[:30] + ("…" if len(action.text) > 30 else "")
        return f'type({action.element_id}, "{preview}")'
    if a == "select":
        return f"select({action.element_id}, {action.option})"
    if a == "scroll":
        return f"scroll({action.direction}, {action.amount}px)"
    if a == "navigate":
        return f"navigate({action.url})"
    if a == "wait":
        return f"wait({action.duration_ms}ms)"
    if a == "extract":
        return f"extract({action.element_id})"
    return a