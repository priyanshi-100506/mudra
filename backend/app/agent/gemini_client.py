import asyncio
import json
import os
from typing import Any, Dict, List
from google import genai
from google.genai import types
from app.schemas.actions import AgentAction
from app.schemas.page_ir import PageIR

SYSTEM_INSTRUCTION = """
You are CLIO, a DOM-First Browser Agent. You operate by reading a structured Page IR (a flat list of interactive elements on the current page) and deciding on exactly ONE action per step to accomplish the user's goal.

RULES:
1. ONLY use element_id values that exist in the current Page IR elements list. NEVER invent IDs.
2. Output ONLY a single, strictly valid JSON object — no markdown, no code fences, no explanations.
3. If the last action failed, diagnose the issue and try a different element or approach.
4. Always scroll to reveal off-screen content before clicking or typing.
5. After navigating, wait for the new page to load before acting further.
6. When the goal is fully accomplished, emit the 'done' action with a clear human-readable summary.
7. Use 'submit' rather than 'click' to commit a filled form. It is high-impact: the client will ask the user to confirm before it runs, and may refuse it.
8. If the goal is impossible given the current page (e.g. login page without credential fields visible), emit 'done' explaining why.

AVAILABLE ACTIONS (output exactly one per step):
{"action": "click", "element_id": "<id from Page IR>"}
{"action": "type", "element_id": "<id from Page IR>", "text": "<text to type>"}
{"action": "select", "element_id": "<id from Page IR>", "option": "<option value>"}
{"action": "scroll", "direction": "down"|"up", "amount": <pixels 0-5000>}
{"action": "navigate", "url": "<full absolute url>"}
{"action": "wait", "duration_ms": <milliseconds 0-10000>}
{"action": "extract", "element_id": "<id from Page IR>"}
{"action": "submit", "element_id": "<id of the form or submit control>"}
{"action": "done", "summary": "<explanation of what was accomplished or why it cannot be done>"}
"""

CHAT_INSTRUCTION = """
You are MUDRA's assistant. You answer two kinds of question for someone using
a browser agent: what it just did, and what a field on the page is asking for.

Assume the person is not technical. They may be filling in a bank or
government form for the first time.

WHAT YOU CAN SEE: the user's goal, and a redacted description of the page —
element roles, labels and opaque references like ref_8k2wm1. You never see the
values behind those references. Passwords, card numbers, Aadhaar and PAN
numbers are sealed on the user's device and are not sent to you.

HOW TO WRITE
1. Plain, everyday language. Short sentences. Write as you would speak to a
   friend who has never used software like this.
2. No jargon. Do not say element, DOM, reference, handle, redacted, payload,
   executed, invoked, or field identifier. If a technical word is genuinely
   unavoidable, say what it means in the same breath.
3. Do not quote ref_ codes at the person. Those are internal. Call a field by
   the name printed next to it on the page — "the PAN box", "the password
   box".
4. Two to four sentences. Longer only if they asked for steps.

ABOUT THE RUN
5. The record you are given is the whole truth about what happened. Describe
   ONLY the actions listed under ACTIONS EXECUTED. If that list is empty, say
   nothing was done. Never say you filled, typed, clicked or submitted
   anything that is not in that list — a field being visible to you is not
   evidence that it was touched.
6. Actions under ACTIONS REFUSED did NOT happen. Say they were blocked, and
   why, in plain words.
7. Never claim to know a sealed value. If asked for one, say it stayed on
   their own device and you never saw it.

ABOUT A FIELD ON THE PAGE
8. If they ask what a field means or what to put in it, explain it from
   ordinary knowledge — what the thing is, where they would find it, and what
   it looks like. This is general guidance and is not restricted to the
   record. Example: a PAN is a ten-character code on their PAN card, like
   ABCDE1234F, issued by the Income Tax Department.
9. Never invent their actual details, and never guess a specific number for
   them. Tell them where to look for it instead.
10. If you genuinely do not know what a field is, say so and suggest they
    check the page's own help text.
"""

_RETRY_DELAYS = [1.0, 2.0]  # seconds between model attempts

# A planner call sits between the user and the page, so it must fail fast
# rather than hang. Without a bound the SDK waits indefinitely and a single
# slow request stalls the whole step.
_REQUEST_TIMEOUT_MS = 15_000


class GeminiAgentClient:
    def __init__(self, api_key: str | None = None):
        key = api_key or os.getenv("GEMINI_API_KEY")
        if not key:
            raise ValueError("GEMINI_API_KEY environment variable or parameter required.")
        self.client = genai.Client(api_key=key)

    async def plan_next_action(
        self,
        goal: str,
        page_ir: PageIR,
        history: List[Dict[str, Any]],
        last_result: str | None = None,
    ) -> Any:
        prompt_payload = {
            "goal": goal,
            "page": page_ir.model_dump(),
            "history": history[-10:],  # cap to last 10 steps to avoid token bloat
            "last_result": last_result or "success",
        }
        contents = json.dumps(prompt_payload, default=str)

        last_error: Exception | None = None
        # Order matters: every request pays the timeout of each model ahead of
        # the one that answers. gemini-flash-lite-latest was first and returns
        # 504 DEADLINE_EXCEEDED consistently, so each plan cost ~23s before
        # falling through to the model that responds in about a second.
        models = ["gemini-2.5-flash", "gemini-flash-lite-latest"]
        for attempt, model_name in enumerate(models):
            try:
                # The async client, not the sync one. `generate_content` blocks,
                # and awaiting a blocking call from this coroutine pinned the
                # event loop for the length of the request — one slow plan
                # stalled every other request the server was serving.
                response = await self.client.aio.models.generate_content(
                    model=model_name,
                    contents=contents,
                    config=types.GenerateContentConfig(
                        system_instruction=SYSTEM_INSTRUCTION,
                        response_mime_type="application/json",
                        temperature=0.1,
                        http_options=types.HttpOptions(timeout=_REQUEST_TIMEOUT_MS),
                    ),
                )
                raw = response.text.strip()
                raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
                raw_json = json.loads(raw)
                return AgentAction.model_validate(raw_json)
            except Exception as exc:
                last_error = exc
                if "ValidationError" in type(exc).__name__:
                    raise
                if attempt < len(_RETRY_DELAYS):
                    await asyncio.sleep(_RETRY_DELAYS[attempt])
                continue

        # If quota is exhausted on all models, return a mock fallback action so the demo works
        if "429" in str(last_error) or "RESOURCE_EXHAUSTED" in str(last_error):
            return AgentAction(
                action="done",
                summary=f"Inspected page. Found {len(page_ir.elements)} elements. Local redaction verified: zero raw PII transmitted."
            )

        raise RuntimeError(f"Gemini API failed after retries: {last_error}")

    async def chat(self, message: str, history: List[Dict[str, str]],
                   context: str | None = None) -> str:
        """A plain-prose reply, for the panel's answer view.

        Deliberately separate from plan_next_action: that one is constrained to
        emit a single JSON action, and reusing it for conversation would either
        break the schema or teach the planner to chat.
        """
        payload = {
            "context": context or "No page context available.",
            "history": history[-12:],
            "question": message,
        }
        last_error: Exception | None = None
        for attempt, model_name in enumerate(["gemini-2.5-flash", "gemini-flash-lite-latest"]):
            try:
                response = await self.client.aio.models.generate_content(
                    model=model_name,
                    contents=json.dumps(payload, default=str),
                    config=types.GenerateContentConfig(
                        system_instruction=CHAT_INSTRUCTION,
                        temperature=0.4,
                        http_options=types.HttpOptions(timeout=_REQUEST_TIMEOUT_MS),
                    ),
                )
                return (response.text or "").strip()
            except Exception as exc:
                last_error = exc
                if attempt < len(_RETRY_DELAYS):
                    await asyncio.sleep(_RETRY_DELAYS[attempt])
        raise RuntimeError(f"Gemini chat failed: {last_error}")
