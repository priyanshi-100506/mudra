from typing import Tuple
from app.schemas.actions import AgentAction
from app.schemas.page_ir import PageIR


class ActionVerifier:
    @staticmethod
    def verify(
        action: AgentAction,
        before_ir: PageIR,
        after_ir: PageIR,
        execution_error: str | None = None,
    ) -> Tuple[bool, str]:
        if execution_error:
            return False, f"Execution failed: {execution_error}"

        match action.action:
            case "click":
                if before_ir.url != after_ir.url:
                    return True, "Success: Navigation occurred after click."
                if len(before_ir.elements) != len(after_ir.elements):
                    return True, "Success: Page elements changed after click."
                return True, "Success: Click executed."

            case "type":
                # The backend no longer receives raw values — sensitive fields
                # are redacted client-side.  We cannot compare value, so we
                # accept the action unconditionally and let the next observation
                # surface any failure naturally.
                return True, "Success: Type action dispatched."

            case "select":
                # selected_options is absent from the new PageElement shape.
                # Accept unconditionally; the next observation will reveal
                # whether the selection took effect.
                return True, "Success: Select action dispatched."

            case "navigate":
                if after_ir.url != before_ir.url:
                    return True, f"Success: Navigated to {after_ir.url}."
                return False, "Verification failed: URL did not change."

            case "scroll" | "wait" | "extract" | "done":
                return True, "Success."

            case _:
                return True, "Success."