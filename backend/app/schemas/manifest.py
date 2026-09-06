from datetime import datetime
from typing import Literal, Optional, Dict, Any
from pydantic import BaseModel, Field
import uuid


class EgressManifestEntry(BaseModel):
    id: str = Field(default_factory=lambda: f"meg_{uuid.uuid4().hex[:8]}")
    session_id: str = Field(default="default", description="Session identifier")
    timestamp: str = Field(default_factory=lambda: datetime.utcnow().isoformat() + "Z")
    target_url: str = Field(..., description="Destination URL for the outbound payload/action")
    action_type: str = Field(..., description="Action type executed or requested (e.g. click, type, submit)")
    status: Literal["allowed", "refused"] = Field(..., description="Whether action/egress was allowed by grant policy or refused")
    redacted_refs_count: int = Field(default=0, description="Count of redacted PII tokens in payload")
    details: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Additional non-sensitive metadata")
