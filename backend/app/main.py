import html as _html
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.agent.gemini_client import GeminiAgentClient
from app.agent.loop import AgentLoop, LoopStepResponse
from app.config import settings
from app.schemas.page_ir import PageIR

app = FastAPI(title="CLIO v0.1 Backend Agent API", version="0.1.0")

# Brand assets for the pages this service renders (/test, the audit viewer).
app.mount(
    "/static",
    StaticFiles(directory=Path(__file__).parent / "static"),
    name="static",
)

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


from typing import Optional, List
from app.schemas.manifest import EgressManifestEntry
from app.manifest_store import manifest_store

@app.post("/manifest/record", response_model=EgressManifestEntry)
def record_manifest(entry: EgressManifestEntry):
    return manifest_store.record(entry)

@app.get("/manifests", response_model=List[EgressManifestEntry])
def list_manifests(session_id: Optional[str] = None, status: Optional[str] = None):
    return manifest_store.list_entries(session_id=session_id, status=status)

@app.get("/manifests/{entry_id}", response_model=EgressManifestEntry)
def get_manifest_entry(entry_id: str):
    entry = manifest_store.get_entry(entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Manifest entry not found")
    return entry

@app.get("/manifests/viewer/html", response_class=HTMLResponse)
def manifest_viewer_html():
    entries = manifest_store.list_entries()
    rows = ""
    for e in entries:
        color = "#5DE0A6" if e.status == "allowed" else "#FF8A8A"
        # Every field below originates in the extension. The audit page must not
        # be scriptable by the pages it audits, so nothing is interpolated raw.
        esc = lambda v: _html.escape(str(v), quote=True)
        rows += f"""
        <tr>
            <td style="padding: 10px 14px; border-top: 1px solid rgba(255,255,255,.08);">{esc(e.id)}</td>
            <td style="padding: 10px 14px; border-top: 1px solid rgba(255,255,255,.08);">{esc(e.timestamp)}</td>
            <td style="padding: 10px 14px; border-top: 1px solid rgba(255,255,255,.08);">{esc(e.session_id)}</td>
            <td style="padding: 10px 14px; border-top: 1px solid rgba(255,255,255,.08);">{esc(e.target_url)}</td>
            <td style="padding: 10px 14px; border-top: 1px solid rgba(255,255,255,.08);"><code>{esc(e.action_type)}</code></td>
            <td style="padding: 10px 14px; border-top: 1px solid rgba(255,255,255,.08); color: {color}; font-weight: 700;">{esc(e.status.upper())}</td>
            <td style="padding: 10px 14px; border-top: 1px solid rgba(255,255,255,.08);">{esc(e.redacted_refs_count)}</td>
        </tr>
        """
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>MUDRA Egress Audit Manifest Viewer</title>
        <style>
            body {{
                font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 28px 24px 48px;
                min-height: 100vh; color: #EAF0FF;
                background: #082F49;
                background-image: linear-gradient(158deg, #082F49 0%, #0C4A6E 46%, #0369A1 100%);
                background-attachment: fixed;
            }}
            .masthead {{ display: flex; align-items: center; gap: 18px; margin: 0 0 26px; }}
            .lockup {{ height: 54px; width: auto; flex: none; }}
            h1 {{ color: #FFFFFF; margin: 0 0 5px; font-size: 21px; letter-spacing: -.01em; }}
            .masthead p {{ margin: 0; color: #C9E9FA; font-size: 13px; }}
            table {{
                width: 100%; border-collapse: collapse; overflow: hidden;
                background: rgba(255,255,255,.05); border-radius: 12px;
                border: 1px solid rgba(255,255,255,.10);
                backdrop-filter: blur(6px);
            }}
            th {{
                background: rgba(255,255,255,.07); padding: 12px 14px; text-align: left;
                font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #BAE6FD;
                font-weight: 600;
            }}
            td {{ font-size: 13px; }}
        </style>
    </head>
    <body>
        <header class="masthead">
            <img src="/static/mudra-lockup-dark.svg" alt="Mudra" class="lockup" />
            <div>
                <h1>Egress Audit Manifest</h1>
                <p>Zero raw PII leaves the client. Below is the active log of all outbound actions &amp; grant authorizations.</p>
            </div>
        </header>
        <table>
            <thead>
                <tr>
                    <th>ID</th><th>Timestamp</th><th>Session</th><th>Target URL</th><th>Action</th><th>Status</th><th>Redacted PII Tokens</th>
                </tr>
            </thead>
            <tbody>
                {rows if rows else '<tr><td colspan="7" style="padding: 22px; text-align: center; color: #C9E9FA;">No egress manifest entries recorded yet.</td></tr>'}
            </tbody>
        </table>
    </body>
    </html>
    """
    return HTMLResponse(content=html)


@app.post("/agent/step", response_model=LoopStepResponse)
async def run_agent_step(payload: AgentStepRequest):
    loop = get_session(payload.session_id)
    try:
        response = await loop.step(
            goal=payload.goal,
            current_ir=payload.page_ir,
            session_id=payload.session_id,
        )
        return response
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))