"""Local vision-language planner, over Ollama on this machine.

This is the offline path, and the reason the redaction work has somewhere to
land: the model is handed the *redacted* screenshot alongside the scene graph,
so it can reason about layout the DOM does not describe without ever seeing a
face or an identity number.

One operational note that costs an afternoon if nobody writes it down: Ollama
allows no extension origin by default, so every request from the extension
comes back 403. It has to be started as

    OLLAMA_ORIGINS='chrome-extension://*' ollama serve

The failure is quiet in the worst way — the backend is up, the model is
loaded, and local inference simply never runs.
"""

import base64
import json
from typing import Any, Dict, List, Optional

import httpx

from app.config import settings
from app.schemas.page_ir import PageIR

SYSTEM_INSTRUCTION = """You are MUDRA, a browser agent that plans one action at a time.

You are given a redacted view of a web page: a list of interactive elements,
and sometimes an image of the page with sensitive regions blacked out. Values
of protected fields are never shown to you, and their ids are opaque
references. This is deliberate. Plan around them; never guess what they hold.

Output ONLY a single valid JSON object. No prose, no markdown, no code fences.

{"action": "click", "element_id": "<id>"}
{"action": "type", "element_id": "<id>", "text": "<text>"}
{"action": "select", "element_id": "<id>", "option": "<option>"}
{"action": "scroll", "direction": "down"|"up", "amount": <0-5000>}
{"action": "navigate", "url": "<absolute url>"}
{"action": "wait", "duration_ms": <0-10000>}
{"action": "extract", "element_id": "<id>"}
{"action": "submit", "element_id": "<id>"}
{"action": "done", "summary": "<what was achieved, or why it cannot be>"}

Use only element ids present in the page description. Never invent one.
"""


class OllamaUnavailable(RuntimeError):
    """Raised when the local model cannot be reached or refuses the request."""


def _strip_fences(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[-1]
        t = t.rsplit("```", 1)[0]
    return t.strip()


def _first_json_object(text: str) -> Dict[str, Any]:
    """Pulls the first JSON object out of a reply.

    Small local models add a sentence before the JSON more often than hosted
    ones do, even when told not to. Failing the whole step over a stray
    preamble would make the offline path look far worse than it is.
    """
    t = _strip_fences(text)
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass
    depth = 0
    start = -1
    for i, ch in enumerate(t):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start >= 0:
                try:
                    return json.loads(t[start:i + 1])
                except json.JSONDecodeError:
                    start = -1
    raise OllamaUnavailable(f"Local model returned no JSON object: {t[:200]!r}")


def _describe(page_ir: PageIR) -> str:
    lines = [f"URL: {page_ir.url}", f"Title: {page_ir.title}", "Elements:"]
    for el in page_ir.elements:
        bits = [f'id={el.id}', f'role={el.role}', f'name="{el.name}"']
        if el.input_type:
            bits.append(f"type={el.input_type}")
        if el.value:
            bits.append(f'value="{el.value}"')
        lines.append("  " + " ".join(bits))
    if page_ir.text_snippets:
        lines.append("Page text: " + " | ".join(page_ir.text_snippets[:8]))
    return "\n".join(lines)


def _image_payload(screenshot_b64: Optional[str]) -> List[str]:
    """Ollama wants bare base64, not a data URL."""
    if not screenshot_b64:
        return []
    raw = screenshot_b64
    if raw.startswith("data:"):
        raw = raw.split(",", 1)[-1]
    try:
        base64.b64decode(raw, validate=False)
    except Exception:
        return []
    return [raw]


class OllamaAgentClient:
    """Plans against a local VLM. Same interface as the hosted client."""

    name = "ollama"

    def __init__(self, url: Optional[str] = None, model: Optional[str] = None):
        self.url = (url or settings.OLLAMA_URL).rstrip("/")
        self.model = model or settings.OLLAMA_MODEL

    async def health(self) -> Dict[str, Any]:
        """Reports whether the model is actually there, not merely the server.

        A running Ollama with the model absent answers requests and fails
        every one of them, which reads as "the agent got worse" rather than
        "the model was never pulled".
        """
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{self.url}/api/tags")
                resp.raise_for_status()
                tags = resp.json().get("models", [])
        except Exception as exc:
            return {"reachable": False, "model_present": False, "detail": str(exc)}

        names = {m.get("name", "") for m in tags}
        present = any(n == self.model or n.startswith(self.model.split(":")[0]) for n in names)
        return {
            "reachable": True,
            "model_present": present,
            "detail": None if present else f"{self.model} is not pulled; run: ollama pull {self.model}",
        }

    async def plan_next_action(
        self,
        goal: str,
        page_ir: PageIR,
        history: Optional[List[Dict[str, Any]]] = None,
        last_result: Optional[str] = None,
        **_: Any,
    ) -> Dict[str, Any]:
        history = history or []
        parts = [
            f"Goal: {goal}",
            "",
            _describe(page_ir),
        ]
        if history:
            parts += ["", "Actions so far:"]
            parts += [f"  {json.dumps(h.get('action'))}" for h in history[-6:]]
        if last_result:
            parts += ["", f"Result of the last action: {last_result}"]
        parts += ["", "Respond with one JSON action object."]

        body: Dict[str, Any] = {
            "model": self.model,
            "prompt": "\n".join(parts),
            "system": SYSTEM_INSTRUCTION,
            "stream": False,
            "format": "json",
            "options": {"temperature": 0.1},
        }
        # The redacted image, when one passed verification. Nothing reaches
        # here unless the client already confirmed it reads clean.
        images = _image_payload(page_ir.screenshot_b64)
        if images:
            body["images"] = images

        try:
            async with httpx.AsyncClient(timeout=settings.OLLAMA_TIMEOUT_S) as client:
                resp = await client.post(f"{self.url}/api/generate", json=body)
        except httpx.RequestError as exc:
            raise OllamaUnavailable(
                f"Cannot reach Ollama at {self.url}: {exc}. "
                "Is it running? Start it with: "
                "OLLAMA_ORIGINS='chrome-extension://*' ollama serve"
            ) from exc

        if resp.status_code == 403:
            raise OllamaUnavailable(
                "Ollama returned 403. Its CORS allowlist has no extension origin by "
                "default, so it must be started as: "
                "OLLAMA_ORIGINS='chrome-extension://*' ollama serve"
            )
        if resp.status_code >= 400:
            raise OllamaUnavailable(f"Ollama HTTP {resp.status_code}: {resp.text[:200]}")

        return _first_json_object(resp.json().get("response", ""))
