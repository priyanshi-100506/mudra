from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from app.agent.gemini_client import GeminiAgentClient
from app.agent.loop import AgentLoop, LoopStepResponse
from app.config import settings
from app.schemas.page_ir import PageIR

app = FastAPI(title="CLIO v0.1 Backend Agent API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Per-session agent loop registry
_sessions: dict[str, AgentLoop] = {}

try:
    gemini_client = GeminiAgentClient(api_key=settings.GEMINI_API_KEY)
except Exception:
    gemini_client = None


def get_session(session_id: str) -> AgentLoop:
    if session_id not in _sessions:
        if not gemini_client:
            raise HTTPException(
                status_code=500,
                detail="Gemini client not initialized. Check GEMINI_API_KEY in .env file.",
            )
        _sessions[session_id] = AgentLoop(gemini_client=gemini_client)
    return _sessions[session_id]


class AgentStepRequest(BaseModel):
    goal: str
    page_ir: PageIR
    session_id: str = "default"


class ResetRequest(BaseModel):
    session_id: str = "default"


@app.get("/health")
def health_check():
    return {"status": "ok", "gemini_configured": bool(settings.GEMINI_API_KEY)}


@app.get("/test", response_class=HTMLResponse)
def test_page():
    """Serves a local HTML test page for manually running the CLIO agent against a known form."""
    html_path = Path(__file__).parent / "test_page.html"
    return HTMLResponse(content=html_path.read_text(encoding="utf-8"))


@app.post("/agent/reset")
def reset_session(req: ResetRequest):
    if req.session_id in _sessions:
        _sessions[req.session_id].reset()
    return {"status": "reset", "session_id": req.session_id}


@app.get("/agent/status/{session_id}")
def session_status(session_id: str):
    if session_id not in _sessions:
        return {"session_id": session_id, "steps": 0, "active": False}
    loop = _sessions[session_id]
    return {
        "session_id": session_id,
        "steps": len(loop.history),
        "retry_count": loop.retry_count,
        "last_result": loop.last_result,
    }


@app.post("/agent/step", response_model=LoopStepResponse)
async def run_agent_step(payload: AgentStepRequest):
    loop = get_session(payload.session_id)
    try:
        response = await loop.step(goal=payload.goal, current_ir=payload.page_ir)
        return response
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))