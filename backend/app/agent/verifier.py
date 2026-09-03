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
                target_el = next((e for e in after_ir.elements if e.id == action.element_id), None)
                if target_el and target_el.value == action.text:
                    return True, f"Success: Element value updated to '{action.text}'."
                return False, "Verification failed: Input element value did not update."

            case "select":
                target_el = next((e for e in after_ir.elements if e.id == action.element_id), None)
                if target_el and target_el.selected_options and action.option in target_el.selected_options:
                    return True, f"Success: Selected option '{action.option}'."
                return False, "Verification failed: Dropdown selected option did not update."

            case "navigate":
                if after_ir.url != before_ir.url:
                    return True, f"Success: Navigated to {after_ir.url}."
                return False, "Verification failed: URL did not change."

            case "scroll" | "wait" | "extract" | "done":
                return True, "Success."

            case _:
                return True, "Success."